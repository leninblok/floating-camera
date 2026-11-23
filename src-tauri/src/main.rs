#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
#[cfg(target_os = "macos")]
use tauri::menu::Submenu;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

struct RuntimeState {
    settings: Mutex<Value>,
    settings_path: PathBuf,
    smoke: bool,
    smoke_report: Option<PathBuf>,
    running: AtomicBool,
    mouse_enabled: AtomicBool,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
impl Bounds {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.x.abs() <= 1_000_000.
            && self.y.abs() <= 1_000_000.
            && (1. ..=10100.).contains(&self.width)
            && (1. ..=10100.).contains(&self.height)
    }
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn local_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (["http", "https"].contains(&url.scheme()) && url.host_str() == Some("tauri.localhost"))
}
fn state_path(app: &tauri::AppHandle, smoke: bool) -> tauri::Result<PathBuf> {
    if smoke {
        Ok(std::env::temp_dir()
            .join(format!("kruzhok-smoke-{}", std::process::id()))
            .join("settings.json"))
    } else {
        Ok(app.path().app_config_dir()?.join("settings.json"))
    }
}
fn load_settings(path: &PathBuf) -> Value {
    let mut candidates = vec![path.clone()];
    if let Some(parent) = path.parent().and_then(|p| p.parent()) {
        for name in ["kruzhok", "Кружок", "floating-camera"] {
            candidates.push(parent.join(name).join("settings.json"));
        }
    }
    for file in candidates {
        if let Ok(bytes) = fs::read(file) {
            if bytes.len() > 16384 {
                continue;
            }
            if let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) {
                if value.is_object() {
                    if value.get("x").is_none() {
                        value["x"] = value.get("lastX").cloned().unwrap_or(Value::Null);
                    }
                    if value.get("y").is_none() {
                        value["y"] = value.get("lastY").cloned().unwrap_or(Value::Null);
                    }
                    return value;
                }
            }
        }
    }
    json!({})
}
fn save(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = app.state::<RuntimeState>();
    let value = runtime.settings.lock().map_err(err)?.clone();
    let path = &runtime.settings_path;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let temp = path.with_extension("tmp");
    fs::write(&temp, serde_json::to_vec_pretty(&value).map_err(err)?).map_err(err)?;
    fs::rename(temp, path).map_err(err)
}
fn overlay(window: &WebviewWindow) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    #[cfg(target_os = "macos")]
    let _ = window.with_webview(|view| unsafe {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let native: &NSWindow = &*view.ns_window().cast();
        native.setLevel(1000);
        native.setHidesOnDeactivate(false);
        native.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
    });
}
#[tauri::command]
fn bootstrap(window: WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    let scale = window.scale_factor().map_err(err)?;
    let monitors=window.available_monitors().map_err(err)?.into_iter().enumerate().map(|(id,m)|{
        let area=m.work_area();
        // Cocoa reports each monitor in its own backing-pixel scale. Convert
        // to Cocoa points independently, including non-Retina external screens.
        #[cfg(target_os="macos")]
        let scale=m.scale_factor();
        json!({"id":id,"scaleFactor":m.scale_factor(),"workArea":{"x":area.position.x as f64/scale,"y":area.position.y as f64/scale,
            "width":area.size.width as f64/scale,"height":area.size.height as f64/scale},
            "bounds":{"x":m.position().x as f64/scale,"y":m.position().y as f64/scale,"width":m.size().width as f64/scale,"height":m.size().height as f64/scale}})
    }).collect::<Vec<_>>();
    let runtime = app.state::<RuntimeState>();
    Ok(
        json!({"settings":runtime.settings.lock().map_err(err)?.clone(),"monitors":monitors,"scaleFactor":scale,
        "platform":std::env::consts::OS,"smoke":runtime.smoke,"version":app.package_info().version.to_string()}),
    )
}
#[tauri::command]
fn native_status(window: WebviewWindow) -> Result<Value, String> {
    let scale = window.scale_factor().map_err(err)?;
    let position = window.outer_position().map_err(err)?;
    let size = window.inner_size().map_err(err)?;
    // Tao's macOS getter tests equality with floating level 4. Kruzhok uses
    // screen-saver level 1000, matching the original overlay above full-screen apps.
    #[cfg(target_os = "macos")]
    let level = unsafe {
        (&*window
            .ns_window()
            .map_err(err)?
            .cast::<objc2_app_kit::NSWindow>())
            .level()
    };
    #[cfg(target_os = "macos")]
    let always_on_top = level >= 1000;
    #[cfg(not(target_os = "macos"))]
    let always_on_top = window.is_always_on_top().map_err(err)?;
    Ok(
        json!({"bounds":{"x":position.x as f64/scale,"y":position.y as f64/scale,"width":size.width as f64/scale,"height":size.height as f64/scale},"visible":window.is_visible().map_err(err)?,"alwaysOnTop":always_on_top}),
    )
}
#[tauri::command]
fn apply_bounds(window: WebviewWindow, bounds: Bounds) -> Result<(), String> {
    if !bounds.valid() {
        return Err("Invalid window bounds".into());
    }
    window
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(err)?;
    window
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(err)
}
#[tauri::command]
fn reveal(window: WebviewWindow) -> Result<(), String> {
    overlay(&window);
    window.show().map_err(err)
}
#[tauri::command]
fn mouse_events(window: WebviewWindow, app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let runtime = app.state::<RuntimeState>();
    if runtime.mouse_enabled.swap(enabled, Ordering::Relaxed) != enabled {
        window.set_ignore_cursor_events(!enabled).map_err(err)?;
    }
    Ok(())
}
#[tauri::command]
fn set_shadow(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_shadow(enabled).map_err(err)
}
#[tauri::command]
fn refresh_shadow(window: WebviewWindow) {
    #[cfg(target_os = "macos")]
    let _ = window.with_webview(|view| unsafe {
        let native: &objc2_app_kit::NSWindow = &*view.ns_window().cast();
        native.invalidateShadow();
    });
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}
#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Value) -> Result<(), String> {
    if !settings.is_object() || settings.to_string().len() > 8192 {
        return Err("Invalid settings".into());
    }
    *app.state::<RuntimeState>().settings.lock().map_err(err)? = settings;
    save(&app)
}
fn checked(
    app: &tauri::AppHandle,
    id: &str,
    text: &str,
    on: bool,
) -> tauri::Result<tauri::menu::CheckMenuItem<tauri::Wry>> {
    CheckMenuItemBuilder::with_id(id, text)
        .checked(on)
        .build(app)
}
fn controls(
    app: &tauri::AppHandle,
    state: &Value,
    context: bool,
) -> tauri::Result<Menu<tauri::Wry>> {
    let camera = state.get("cameraDeviceId").and_then(Value::as_str);
    let mut cameras = SubmenuBuilder::new(app, "Выбрать камеру").item(&checked(
        app,
        "camera:auto",
        "Автоматически",
        camera.is_none(),
    )?);
    if let Some(devices) = state.get("cameraDevices").and_then(Value::as_array) {
        for device in devices {
            if let (Some(id), Some(label)) = (
                device.get("id").and_then(Value::as_str),
                device.get("label").and_then(Value::as_str),
            ) {
                if !id.is_empty() && id.len() <= 1024 && label.len() <= 1024 {
                    cameras = cameras.item(&checked(
                        app,
                        &format!("camera:{id}"),
                        label,
                        camera == Some(id),
                    )?);
                }
            }
        }
    }
    let shape = state
        .get("shapeMode")
        .and_then(Value::as_str)
        .unwrap_or("rectangle");
    let shapes = SubmenuBuilder::new(app, "Форма")
        .item(&checked(app, "shape:circle", "Круг", shape == "circle")?)
        .item(&checked(
            app,
            "shape:rectangle",
            "Прямоугольник",
            shape == "rectangle",
        )?)
        .build()?;
    let mut menu = MenuBuilder::new(app)
        .item(&cameras.build()?)
        .separator()
        .item(&shapes);
    if shape == "rectangle" {
        let ratio = state
            .get("aspectRatio")
            .and_then(Value::as_str)
            .unwrap_or("9:16");
        let mut aspects = SubmenuBuilder::new(app, "Соотношение сторон");
        for value in ["1:1", "4:5", "9:16"] {
            aspects = aspects.item(&checked(
                app,
                &format!("aspect:{value}"),
                value,
                ratio == value,
            )?);
        }
        menu = menu.item(&aspects.build()?);
    }
    let mut sizes = SubmenuBuilder::new(app, "Размер");
    if let Some(presets) = state.get("sizes").and_then(Value::as_array) {
        for preset in presets {
            if let (Some(id), Some(label)) = (
                preset.get("id").and_then(Value::as_str),
                preset.get("label").and_then(Value::as_str),
            ) {
                sizes = sizes.item(&checked(
                    app,
                    &format!("size:{id}"),
                    label,
                    state.get("sizePresetId").and_then(Value::as_str) == Some(id),
                )?);
            }
        }
    }
    let flag = |key: &str| state.get(key).and_then(Value::as_bool).unwrap_or(false);
    let appearance = SubmenuBuilder::new(app, "Оформление")
        .item(&checked(app, "border", "Контур", flag("borderEnabled"))?)
        .item(&checked(app, "shadow", "Тень", flag("shadowEnabled"))?)
        .build()?;
    menu = menu
        .item(&sizes.build()?)
        .item(&appearance)
        .item(&checked(
            app,
            "mirror",
            "Отразить по горизонтали",
            flag("mirrorEnabled"),
        )?)
        .item(&checked(app, "focus", "Фокус", flag("focusEnabled"))?);
    if context {
        menu = menu
            .separator()
            .text("check-updates", "Проверить обновления")
            .text("release", "Открыть последний релиз");
        if let Some(status) = state
            .get("updateStatus")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            menu = menu.item(&MenuItemBuilder::new(status).enabled(false).build(app)?);
        }
        menu = menu.separator().item(
            &MenuItemBuilder::with_id("quit", "Закрыть")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        );
    }
    menu.build()
}
#[tauri::command]
fn sync_menu(app: tauri::AppHandle, state: Value) -> Result<(), String> {
    if state.to_string().len() > 32768 {
        return Err("Menu state too large".into());
    }
    let menu = controls(&app, &state, false).map_err(err)?;
    #[cfg(target_os = "macos")]
    let camera = Submenu::with_items(
        &app,
        "Камера",
        true,
        &menu
            .items()
            .map_err(err)?
            .iter()
            .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
            .collect::<Vec<_>>(),
    )
    .map_err(err)?;
    #[cfg(target_os = "macos")]
    let application = SubmenuBuilder::new(&app, "Кружок")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()
        .map_err(err)?;
    #[cfg(target_os = "macos")]
    let updates = {
        let mut builder = SubmenuBuilder::new(&app, "Обновления")
            .text("check-updates", "Проверить обновления")
            .text("release", "Открыть последний релиз");
        if let Some(status) = state
            .get("updateStatus")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            builder = builder.item(
                &MenuItemBuilder::new(status)
                    .enabled(false)
                    .build(&app)
                    .map_err(err)?,
            );
        }
        builder.build().map_err(err)?
    };
    #[cfg(target_os = "macos")]
    let root = MenuBuilder::new(&app)
        .item(&application)
        .item(&camera)
        .item(&updates)
        .build()
        .map_err(err)?;
    #[cfg(target_os = "macos")]
    app.set_menu(root).map_err(err)?;
    #[cfg(not(target_os = "macos"))]
    let _ = menu;
    Ok(())
}
#[tauri::command]
fn context_menu(window: WebviewWindow, app: tauri::AppHandle, state: Value) -> Result<(), String> {
    if state.to_string().len() > 32768 {
        return Err("Menu state too large".into());
    }
    window
        .popup_menu(&controls(&app, &state, true).map_err(err)?)
        .map_err(err)
}
#[tauri::command]
fn camera_privacy() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
        .spawn()
        .map_err(err)?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", "ms-settings:privacy-webcam"])
        .spawn()
        .map_err(err)?;
    Ok(())
}
fn open_release() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("/usr/bin/open")
        .arg("https://github.com/leninblok/floating-camera/releases/latest")
        .spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("rundll32.exe")
        .args([
            "url.dll,FileProtocolHandler",
            "https://github.com/leninblok/floating-camera/releases/latest",
        ])
        .spawn();
}
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    let _ = save(&app);
    app.exit(0);
}
#[tauri::command]
fn smoke_report(app: tauri::AppHandle, report: Value) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    if !state.smoke {
        return Err("Smoke mode is disabled".into());
    }
    let path = state.smoke_report.clone().ok_or("Missing report path")?;
    fs::write(path, serde_json::to_vec_pretty(&report).map_err(err)?).map_err(err)?;
    let success = report.get("ok").and_then(Value::as_bool) == Some(true);
    app.exit(if success { 0 } else { 1 });
    Ok(())
}
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let smoke = args.iter().any(|a| a == "--smoke-test");
    let report = args
        .windows(2)
        .find(|a| a[0] == "--smoke-report")
        .map(|a| PathBuf::from(&a[1]));
    tauri::Builder::default()
      .invoke_handler(tauri::generate_handler![bootstrap,native_status,apply_bounds,reveal,mouse_events,set_shadow,refresh_shadow,save_settings,sync_menu,context_menu,camera_privacy,quit,smoke_report])
      .setup(move |app|{
        let path=state_path(app.handle(),smoke)?;
        let settings=if smoke{json!({})}else{load_settings(&path)};
        app.manage(RuntimeState{settings:Mutex::new(settings),settings_path:path,smoke,smoke_report:report.clone(),running:AtomicBool::new(true),mouse_enabled:AtomicBool::new(true)});
        #[cfg(target_os="macos")]
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        let window=tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("index.html".into()))
          .title("Кружок").inner_size(320.,500.).transparent(true).decorations(false).resizable(false)
          .maximizable(false).minimizable(false).visible(false).always_on_top(true).visible_on_all_workspaces(true)
          .skip_taskbar(true).focused(false).shadow(cfg!(target_os="macos"))
          .on_navigation(local_url)
          .on_permission_request(|_,kind| match kind {tauri::webview::PermissionKind::Camera=>tauri::webview::PermissionResponse::Allow,_=>tauri::webview::PermissionResponse::Deny})
          .build()?;
        overlay(&window);
        let handle=app.handle().clone();
        std::thread::spawn(move ||{
            while handle.state::<RuntimeState>().running.load(Ordering::Relaxed){
                let Some(window)=handle.get_webview_window("main") else{break};
                if window.is_visible().unwrap_or(false){
                    if let (Ok(cursor),Ok(position),Ok(scale))=(window.cursor_position(),window.outer_position(),window.scale_factor()){
                        let _=window.emit("camera:cursor",json!({"x":(cursor.x-position.x as f64)/scale,"y":(cursor.y-position.y as f64)/scale}));
                    }
                }
                std::thread::sleep(Duration::from_millis(33));
            }
        });
        Ok(())
      })
      .on_menu_event(|app,event|{
        match event.id().as_ref(){"quit"=>{let _=save(app);app.exit(0);},"release"=>open_release(),action=>{let _=app.emit("camera:action",action);}}
      })
      .on_window_event(|window,event|{
        if matches!(event,tauri::WindowEvent::Focused(false)){if let Some(view)=window.app_handle().get_webview_window(window.label()){overlay(&view);}}
        if matches!(event,tauri::WindowEvent::ScaleFactorChanged{..}){let _=window.emit("camera:display-changed",());}
      })
      .build(tauri::generate_context!()).expect("Could not start Kruzhok")
      .run(|app,event|{if matches!(event,tauri::RunEvent::ExitRequested{..}){let _=save(app);app.state::<RuntimeState>().running.store(false,Ordering::Relaxed);}});
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_nonfinite_or_unbounded_window_commands() {
        assert!(!Bounds {
            x: f64::NAN,
            y: 0.,
            width: 100.,
            height: 100.
        }
        .valid());
        assert!(!Bounds {
            x: 0.,
            y: 0.,
            width: 20000.,
            height: 100.
        }
        .valid());
        assert!(Bounds {
            x: -1000.,
            y: 48.,
            width: 338.,
            height: 338.
        }
        .valid());
    }
    #[test]
    fn only_packaged_origin_can_navigate() {
        assert!(local_url(
            &tauri::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(local_url(
            &tauri::Url::parse("http://tauri.localhost/index.html").unwrap()
        ));
        assert!(!local_url(
            &tauri::Url::parse("https://example.com").unwrap()
        ));
        assert!(!local_url(
            &tauri::Url::parse("https://tauri.localhost.attacker.example").unwrap()
        ));
    }
}
