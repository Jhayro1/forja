//! Primera vez: descargar la distro de Forja (el rootfs que publica CI), comprobar su
//! SHA-256 e importarla en WSL. Sin Ubuntu, sin crear usuario, sin contraseñas.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::wsl;

const RELEASES: &str = "https://github.com/Jhayro1/forja/releases/latest/download";
pub const ROOTFS: &str = "forja-wsl-x64.tar.gz";
/// Forja como paquete npm, para actualizarla dentro de la distro sin reinstalarla.
pub const PACKAGE: &str = "forja.tgz";

/// Dónde bajar los archivos (FORJA_DESCARGAS permite probar con otra publicación).
pub fn download_base() -> String {
    std::env::var("FORJA_DESCARGAS").unwrap_or_else(|_| RELEASES.to_string())
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub paso: &'static str,
    pub detalle: String,
    /// 0–100, o None si no se sabe cuánto falta.
    pub porcentaje: Option<u8>,
}

/// HTTP con el TLS del sistema (schannel en Windows): usa los certificados de Windows,
/// también los de un proxy corporativo, y no necesita compilar C.
fn agent() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    ureq::Agent::config_builder()
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
}

fn download(url: &str, to: &Path, report: &dyn Fn(Progress)) -> Result<(), String> {
    let mut res = agent()
        .get(url)
        .call()
        .map_err(|e| format!("no se pudo descargar {url}: {e}"))?;
    let total = res.body().content_length();
    let mut reader = res.body_mut().as_reader();
    let mut file =
        File::create(to).map_err(|e| format!("no se pudo escribir {}: {e}", to.display()))?;
    let mut buf = vec![0u8; 1 << 20];
    let (mut done, mut last) = (0u64, u8::MAX);
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("la descarga se cortó: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("no se pudo escribir la descarga: {e}"))?;
        done += n as u64;
        let pct = total.map(|t| ((done * 100) / t.max(1)).min(100) as u8);
        if pct != Some(last) {
            last = pct.unwrap_or(0);
            report(Progress {
                paso: "descargar",
                detalle: format!("{} MB", done / (1 << 20)),
                porcentaje: pct,
            });
        }
    }
    Ok(())
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Descarga, verifica e importa la distro «Forja» en `data_dir/wsl`.
pub fn install(data_dir: &Path, report: &dyn Fn(Progress)) -> Result<(), String> {
    if wsl::distros().iter().any(|d| d == wsl::DISTRO) {
        return Ok(());
    }
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let base = download_base();
    let tarball: PathBuf = data_dir.join(ROOTFS);

    report(Progress {
        paso: "descargar",
        detalle: "empezando…".into(),
        porcentaje: Some(0),
    });
    let expected = agent()
        .get(&format!("{base}/{ROOTFS}.sha256"))
        .call()
        .and_then(|mut r| r.body_mut().read_to_string())
        .map_err(|e| format!("no se pudo descargar la suma de verificación: {e}"))?;
    let expected = expected
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_lowercase();
    download(&format!("{base}/{ROOTFS}"), &tarball, report)?;

    report(Progress {
        paso: "verificar",
        detalle: "comprobando que la descarga está completa…".into(),
        porcentaje: None,
    });
    let actual = sha256(&tarball)?;
    if expected.len() != 64 || actual != expected {
        let _ = std::fs::remove_file(&tarball);
        return Err(
            "la descarga no coincide con su suma de verificación; vuelve a intentarlo".into(),
        );
    }

    report(Progress {
        paso: "importar",
        detalle: "creando la distro de Linux de Forja…".into(),
        porcentaje: None,
    });
    let result = wsl::import(wsl::DISTRO, &data_dir.join("wsl"), &tarball);
    let _ = std::fs::remove_file(&tarball);
    result?;

    report(Progress {
        paso: "comprobar",
        detalle: "arrancando Forja por primera vez…".into(),
        porcentaje: None,
    });
    wsl::forja_version(wsl::DISTRO)
        .map(|_| ())
        .ok_or_else(|| "la distro se importó pero Forja no responde".into())
}

/// Actualiza Forja dentro de la distro con el paquete publicado (sin tocar tus datos).
pub fn update(distro: &str) -> Result<String, String> {
    let url = format!("{}/{PACKAGE}", download_base());
    let out = wsl::exec(
        distro,
        Some("root"),
        &["npm", "install", "-g", "--no-audit", "--no-fund", &url],
    )?;
    if !out.status.success() {
        return Err(format!("no se pudo actualizar: {}", wsl::text(&out.stderr)));
    }
    wsl::forja_version(distro).ok_or_else(|| "Forja no responde después de actualizar".into())
}

/// GET de texto, para las pruebas de integración.
#[cfg(test)]
pub fn tests_http_get(url: &str) -> String {
    agent().get(url).call().and_then(|mut r| r.body_mut().read_to_string()).expect("GET")
}

#[cfg(test)]
mod integration {
    use std::sync::Mutex;

    #[test]
    #[ignore = "necesita WSL y FORJA_DESCARGAS con forja-wsl-x64.tar.gz y su .sha256"]
    fn descarga_verifica_e_importa() {
        let dir = std::env::temp_dir().join(format!("forja-instalar-{}", std::process::id()));
        let seen = Mutex::new(Vec::new());
        super::install(&dir, &|p| seen.lock().unwrap().push(p.paso)).expect("instala");
        let seen = seen.into_inner().unwrap();
        for paso in ["descargar", "verificar", "importar", "comprobar"] {
            assert!(seen.contains(&paso), "falta el paso {paso}: {seen:?}");
        }
        assert!(!dir.join(super::ROOTFS).exists(), "borra la descarga al terminar");
        let _ = std::fs::remove_dir_all(dir);
    }
}
