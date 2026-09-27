//! Todo lo que la app le pide a WSL: qué distros hay, importar la de Forja y correr
//! comandos dentro. Siempre por `wsl.exe` con argumentos sueltos (nunca un string que
//! pase por cmd o PowerShell) y sin abrir ventanas de consola.

use std::path::Path;
use std::process::{Command, Output, Stdio};

/// La distro que instala la app (rootfs de desktop/distro).
pub const DISTRO: &str = "Forja";
/// Distro de quien ya instaló Forja con scripts/instalar.ps1: la app la reutiliza.
pub const UBUNTU: &str = "Ubuntu";

/// `wsl.exe` sin ventana de consola y con salida en UTF-8 (por defecto es UTF-16).
pub fn wsl() -> Command {
    let mut cmd = Command::new("wsl.exe");
    cmd.env("WSL_UTF8", "1").stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Salida de wsl.exe como texto, aunque venga en UTF-16 (versiones viejas ignoran WSL_UTF8).
pub fn text(bytes: &[u8]) -> String {
    let raw = if bytes.len() >= 2 && bytes.iter().skip(1).step_by(2).take(8).all(|b| *b == 0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    raw.replace(['\0', '\u{feff}'], "").trim().to_string()
}

fn run(cmd: &mut Command) -> Result<Output, String> {
    cmd.output()
        .map_err(|e| format!("no se pudo ejecutar wsl.exe: {e}"))
}

fn failure(what: &str, out: &Output) -> String {
    let detail = [text(&out.stderr), text(&out.stdout)]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    format!(
        "{what} (código {}){}",
        out.status.code().unwrap_or(-1),
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    )
}

/// WSL 2 instalado y usable (sin él no hay aislamiento de Linux en Windows).
pub fn available() -> bool {
    // `--version` existe desde el WSL de la tienda; `--status`, en el que trae Windows.
    // Sin distros instaladas alguno puede fallar aunque WSL esté activo: basta uno.
    ["--version", "--status"].iter().any(|arg| {
        run(wsl().arg(arg))
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

pub fn distros() -> Vec<String> {
    match run(wsl().args(["--list", "--quiet"])) {
        Ok(o) if o.status.success() => text(&o.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Corre un programa dentro de la distro (como su usuario por defecto, o como `user`).
pub fn exec(distro: &str, user: Option<&str>, args: &[&str]) -> Result<Output, String> {
    let mut cmd = wsl();
    cmd.args(["--distribution", distro]);
    if let Some(u) = user {
        cmd.args(["--user", u]);
    }
    cmd.arg("--exec").args(args);
    run(&mut cmd)
}

/// La versión de Forja instalada en la distro, si responde.
pub fn forja_version(distro: &str) -> Option<String> {
    // Con --exec no pasa por un shell de login: /usr/local/bin/forja existe en las dos
    // distros (en la de Forja es el de npm; en Ubuntu, el lanzador de instalar.sh).
    let out = exec(distro, None, &["/usr/local/bin/forja", "--version"]).ok()?;
    out.status
        .success()
        .then(|| text(&out.stdout))
        .filter(|v| !v.is_empty())
}

pub fn import(name: &str, dir: &Path, tarball: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("no se pudo crear {}: {e}", dir.display()))?;
    let out = run(wsl()
        .arg("--import")
        .arg(name)
        .arg(dir)
        .arg(tarball)
        .args(["--version", "2"]))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(failure("WSL no pudo importar la distro", &out))
    }
}

/// Activa WSL (pide permiso de administrador una vez; después Windows suele pedir reiniciar).
pub fn enable() -> Result<(), String> {
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Process -FilePath wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("no se pudo pedir permiso de administrador: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(failure(
            "no se pudo activar WSL (¿aceptaste el permiso de administrador?)",
            &out,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::text;

    #[test]
    fn lee_utf8_y_utf16() {
        assert_eq!(text(b"Forja\r\nUbuntu\r\n"), "Forja\r\nUbuntu");
        let utf16: Vec<u8> = "Forja\r\n"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(text(&utf16), "Forja");
    }
}
