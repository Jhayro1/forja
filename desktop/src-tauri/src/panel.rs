//! El panel de Forja corriendo dentro de WSL (`forja ui`), manejado por la app: lo
//! arranca, le pide enlaces de acceso de un solo uso y lo cierra al salir.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::wsl;

/// Un enlace del panel: `http://127.0.0.1:<puerto>/#codigo=<código>`, nada más.
pub fn parse_link(line: &str) -> Option<String> {
    let start = line.find("http://127.0.0.1:")?;
    let link: String = line[start..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    let rest = link.strip_prefix("http://127.0.0.1:")?;
    let (port, code) = rest.split_once("/#codigo=")?;
    let ok = !port.is_empty()
        && port.chars().all(|c| c.is_ascii_digit())
        && !code.is_empty()
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(link)
}

pub struct Panel {
    child: Child,
    stdin: Option<ChildStdin>,
    links: Receiver<String>,
    log: Arc<Mutex<Vec<String>>>,
}

const FIRST_START: Duration = Duration::from_secs(90);
const NEXT_LINK: Duration = Duration::from_secs(15);

impl Panel {
    /// Arranca `forja ui` en la distro y espera su primer enlace (la primera vez WSL
    /// puede tardar en despertar la distro).
    pub fn start(distro: &str) -> Result<(Panel, String), String> {
        let mut child = wsl::wsl()
            .args([
                "--distribution",
                distro,
                "--exec",
                "/usr/local/bin/forja",
                "ui",
                "--sin-navegador",
                "--salir-sin-entrada",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("no se pudo arrancar Forja en WSL: {e}"))?;
        let (tx, links) = channel();
        let log = Arc::new(Mutex::new(Vec::new()));
        let pipes: [Box<dyn std::io::Read + Send>; 2] = [
            Box::new(child.stdout.take().unwrap()),
            Box::new(child.stderr.take().unwrap()),
        ];
        for pipe in pipes {
            let tx = tx.clone();
            let log = Arc::clone(&log);
            thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    if let Some(link) = parse_link(&line) {
                        let _ = tx.send(link);
                    } else if let Ok(mut l) = log.lock() {
                        l.push(line);
                        let excess = l.len().saturating_sub(40);
                        l.drain(..excess);
                    }
                }
            });
        }
        // Sólo los lectores quedan con emisor: si forja ui muere, la espera termina ya.
        drop(tx);
        let stdin = child.stdin.take();
        let mut panel = Panel {
            child,
            stdin,
            links,
            log,
        };
        let first = panel.wait_link(FIRST_START)?;
        Ok((panel, first))
    }

    /// Un enlace nuevo (el anterior ya se usó): `forja ui` imprime uno por cada línea.
    pub fn link(&mut self) -> Result<String, String> {
        while self.links.try_recv().is_ok() {}
        let stdin = self.stdin.as_mut().ok_or("el panel ya se cerró")?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("el panel no responde: {e}"))?;
        self.wait_link(NEXT_LINK)
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn wait_link(&mut self, timeout: Duration) -> Result<String, String> {
        match self.links.recv_timeout(timeout) {
            Ok(link) => Ok(link),
            Err(RecvTimeoutError::Timeout) if self.alive() => {
                Err(format!("Forja no respondió a tiempo.{}", self.tail()))
            }
            Err(_) => Err(format!("Forja se cerró al arrancar.{}", self.tail())),
        }
    }

    fn tail(&self) -> String {
        let lines = self
            .log
            .lock()
            .map(|l| {
                l.iter()
                    .rev()
                    .take(8)
                    .rev()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if lines.is_empty() {
            String::new()
        } else {
            format!("\n\n{lines}")
        }
    }
}

impl Drop for Panel {
    /// Cerrar la entrada basta (`--salir-sin-entrada`): los trabajos en curso siguen.
    fn drop(&mut self) {
        drop(self.stdin.take());
        for _ in 0..30 {
            if !self.alive() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::parse_link;

    #[test]
    fn reconoce_solo_enlaces_del_panel() {
        assert_eq!(
            parse_link("  http://127.0.0.1:45311/#codigo=quM9G7lBaiQc7oHY9DrRVUIfJ5MnZTq-")
                .as_deref(),
            Some("http://127.0.0.1:45311/#codigo=quM9G7lBaiQc7oHY9DrRVUIfJ5MnZTq-")
        );
        assert_eq!(parse_link("Forja en http://127.0.0.1:45311"), None);
        assert_eq!(parse_link("http://127.0.0.1:1/#codigo=x\"><script>"), None);
        assert_eq!(parse_link("http://evil.com/#codigo=abc"), None);
    }
}

/// Con WSL de verdad (Windows) o uno simulado: `cargo test -- --ignored`.
#[cfg(test)]
mod integration {
    use super::Panel;

    #[test]
    #[ignore = "necesita WSL con la distro Forja (o el wsl.exe simulado de la guía)"]
    fn arranca_da_enlaces_nuevos_y_se_cierra() {
        let (mut panel, first) = Panel::start(crate::wsl::DISTRO).expect("arranca");
        let second = panel.link().expect("otro enlace");
        assert_ne!(first, second);
        let base = &first[..first.find("/#").unwrap()];
        assert_eq!(
            &second[..second.find("/#").unwrap()],
            base,
            "mismo servidor"
        );
        let page = crate::install::tests_http_get(&format!("{base}/"));
        assert!(page.contains("forja-nonce"), "sirve el panel");
        drop(panel);
    }
}
