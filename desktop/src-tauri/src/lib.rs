//! App de escritorio de Forja (Windows). No reimplementa nada: instala la distro de WSL
//! con Forja adentro, arranca `forja ui` y muestra ese mismo panel en su ventana.
//!
//! Seguridad: la ventana sólo navega a la propia app y al panel local (127.0.0.1); lo
//! demás se abre en el navegador del sistema. El panel es una página remota para Tauri,
//! así que no tiene acceso a estos comandos (sólo la página del asistente lo tiene).

mod install;
mod panel;
mod wsl;

use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

use panel::Panel;

#[derive(Default)]
struct AppState {
    panel: Mutex<Option<Panel>>,
    /// La página del asistente (para volver a ella desde el menú).
    home: Mutex<Option<Url>>,
}

#[derive(Serialize)]
struct Status {
    windows: bool,
    wsl: bool,
    /// Dónde está Forja: la distro propia, o la Ubuntu de scripts/instalar.ps1.
    distro: Option<String>,
    version_forja: Option<String>,
    version_app: String,
    /// La distro de Ubuntu existe pero sin Forja: se puede ofrecer instalar la propia igual.
    ubuntu_sin_forja: bool,
}

/// Windows, o Linux con FORJA_PROBAR_EN_LINUX (desarrollo: un wsl.exe simulado en el PATH).
fn supported() -> bool {
    cfg!(windows) || std::env::var_os("FORJA_PROBAR_EN_LINUX").is_some()
}

fn find_distro() -> Option<(String, String)> {
    let list = wsl::distros();
    [wsl::DISTRO, wsl::UBUNTU]
        .into_iter()
        .filter(|d| list.iter().any(|x| x == d))
        .find_map(|d| wsl::forja_version(d).map(|v| (d.to_string(), v)))
}

#[tauri::command]
async fn estado(app: AppHandle) -> Status {
    let version_app = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let available = supported() && wsl::available();
        let found = if available { find_distro() } else { None };
        let ubuntu =
            available && found.is_none() && wsl::distros().iter().any(|d| d == wsl::UBUNTU);
        Status {
            windows: supported(),
            wsl: available,
            distro: found.as_ref().map(|f| f.0.clone()),
            version_forja: found.map(|f| f.1),
            version_app,
            ubuntu_sin_forja: ubuntu,
        }
    })
    .await
    .unwrap_or(Status {
        windows: cfg!(windows),
        wsl: false,
        distro: None,
        version_forja: None,
        version_app: String::new(),
        ubuntu_sin_forja: false,
    })
}

#[tauri::command]
async fn activar_wsl() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(wsl::enable)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn instalar(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install::install(&dir, &|p| {
            let _ = emitter.emit("instalacion", p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Un enlace de acceso al panel (arranca `forja ui` si hace falta).
#[tauri::command]
async fn abrir_panel(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fresh_link(&app.state::<AppState>()))
        .await
        .map_err(|e| e.to_string())?
}

fn fresh_link(state: &AppState) -> Result<String, String> {
    let mut guard = state
        .panel
        .lock()
        .map_err(|_| "estado de la app dañado".to_string())?;
    if let Some(p) = guard.as_mut() {
        if p.alive() {
            return p.link();
        }
    }
    let (distro, _) = find_distro().ok_or("Forja no está instalado en WSL")?;
    let (panel, link) = Panel::start(&distro)?;
    *guard = Some(panel);
    Ok(link)
}

#[tauri::command]
async fn actualizar(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (distro, _) = find_distro().ok_or("Forja no está instalado en WSL")?;
        if distro != wsl::DISTRO {
            return Err("Forja está en tu Ubuntu: para actualizarlo vuelve a correr el instalador (scripts/instalar.ps1)".into());
        }
        // El panel en marcha se cierra: el siguiente enlace ya usa la versión nueva.
        let state = app.state::<AppState>();
        state.panel.lock().map_err(|_| "estado de la app dañado")?.take();
        install::update(&distro)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Diagnóstico para pedir ayuda: estado de WSL, distros y `forja doctor`.
#[tauri::command]
async fn diagnostico() -> String {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = vec![
            format!("WSL disponible: {}", wsl::available()),
            format!("Distros: {}", wsl::distros().join(", ")),
        ];
        if let Some((distro, version)) = find_distro() {
            out.push(format!("Forja {version} en «{distro}»"));
            if let Ok(o) = wsl::exec(&distro, None, &["/usr/local/bin/forja", "doctor"]) {
                out.push(wsl::text(&o.stdout));
            }
        }
        out.join("\n")
    })
    .await
    .unwrap_or_default()
}

/// Sólo la app y el panel local se abren dentro de la ventana.
fn inside_app(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "tauri.localhost")
        ),
        _ => false,
    }
}

fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn build_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let nav = app.clone();
    let popup = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("escritorio.html".into()))
        .title("Forja")
        .inner_size(1280.0, 840.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(move |url| {
            let ok = inside_app(url);
            if !ok {
                open_outside(&nav, url);
            }
            ok
        })
        // target="_blank" (p. ej. la página para iniciar sesión en Claude): al navegador.
        .on_new_window(move |url, _| {
            open_outside(&popup, &url);
            NewWindowResponse::Deny
        })
        .build()
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let forja = Submenu::with_items(
        app,
        "Forja",
        true,
        &[
            &MenuItem::with_id(
                app,
                "inicio",
                "Estado de la instalación",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(app, "recargar", "Recargar", true, Some("F5"))?,
            &MenuItem::with_id(
                app,
                "navegador",
                "Abrir en el navegador",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Salir"))?,
        ],
    )?;
    Menu::with_items(app, &[&forja])
}

fn on_menu(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match id {
        "inicio" => {
            if let Some(mut home) = app
                .state::<AppState>()
                .home
                .lock()
                .ok()
                .and_then(|h| h.clone())
            {
                home.set_query(Some("menu=1"));
                let _ = window.navigate(home);
            }
        }
        "recargar" => {
            let _ = window.reload();
        }
        "navegador" => {
            let app = app.clone();
            std::thread::spawn(move || match fresh_link(&app.state::<AppState>()) {
                Ok(link) => {
                    let _ = app.opener().open_url(link, None::<&str>);
                }
                Err(e) => {
                    let _ = app.emit("error", e);
                }
            });
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            estado,
            activar_wsl,
            instalar,
            abrir_panel,
            actualizar,
            diagnostico
        ])
        .setup(|app| {
            let handle = app.handle();
            let window = build_window(handle)?;
            *app.state::<AppState>().home.lock().unwrap() = window.url().ok();
            app.set_menu(build_menu(handle)?)?;
            app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar la app de Forja");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            // Cierra `forja ui` (los trabajos que ya estaban corriendo siguen en WSL).
            if let Ok(mut p) = app.state::<AppState>().panel.lock() {
                p.take();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::inside_app;
    use tauri::Url;

    #[test]
    fn solo_navega_a_la_app_y_al_panel_local() {
        for ok in [
            "http://127.0.0.1:45311/#codigo=x",
            "http://tauri.localhost/escritorio.html",
            "tauri://localhost/escritorio.html",
            "http://localhost:5174/escritorio.html",
        ] {
            assert!(inside_app(&Url::parse(ok).unwrap()), "{ok}");
        }
        for no in [
            "https://claude.ai/oauth",
            "http://127.0.0.1.evil.com/",
            "file:///C:/Windows",
            "javascript:alert(1)",
        ] {
            assert!(!inside_app(&Url::parse(no).unwrap()), "{no}");
        }
    }
}
