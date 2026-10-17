//! Lumo's Rust core and desktop shell.

pub mod agent;
pub mod audit;
pub mod automations;
pub mod commands;
pub mod core;
pub mod db;
pub mod desktop;
pub mod error;
pub mod integrations;
pub mod license;
pub mod live_icon;
pub mod location;
pub mod model;
pub mod models;
pub mod plans;
pub mod policy;
pub mod secrets;
pub mod settings;
pub mod tools;
pub mod util;
pub mod voice;

use std::sync::Arc;
use tauri::{Emitter, Manager};

/// The updater's public key, set at build time by the release workflow (see docs/release.md).
pub fn updater_configured() -> bool {
    option_env!("LUMO_UPDATER_PUBKEY").map(|k| !k.is_empty()).unwrap_or(false)
}

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| desktop::show_main(app)))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .max_file_size(5_000_000)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::new().with_denylist(&["compact", "buddy"]).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init());
    if updater_configured() {
        builder =
            builder.plugin(tauri_plugin_updater::Builder::new().pubkey(option_env!("LUMO_UPDATER_PUBKEY").unwrap_or_default()).build());
    }

    builder
        .register_asynchronous_uri_scheme_protocol("preview", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || match app.try_state::<commands::AppState>() {
                Some(state) => responder.respond(desktop::preview_response(&state.core, &path)),
                None => responder.respond(tauri::http::Response::builder().status(503).body(Vec::new()).unwrap()),
            });
        })
        .setup(|app| {
            let handle = app.handle().clone();
            std::panic::set_hook(Box::new(|info| log::error!("panic: {info}")));

            let data_dir = app.path().app_data_dir()?;
            let log_dir = app.path().app_log_dir()?;
            let projects_dir = dirs::document_dir().unwrap_or_else(|| data_dir.clone()).join("Lumo Projects");
            std::fs::create_dir_all(&data_dir)?;
            let paths = core::Paths { backups_dir: data_dir.join("backups"), data_dir: data_dir.clone(), log_dir, projects_dir };

            let secrets: secrets::Secrets = Arc::new(secrets::OsKeychain);
            let db = match db::Db::open(&data_dir.join("lumo.db"), secrets.as_ref()) {
                Ok(db) => db,
                Err(e) => {
                    // Without its database Lumo can't run safely. Explain and quit rather than
                    // silently starting with no history or an unencrypted store.
                    log::error!("database: {e}");
                    use tauri_plugin_dialog::DialogExt;
                    handle.dialog().message(format!("Lumo can't start.\n\n{e}")).title("Lumo").blocking_show();
                    std::process::exit(1);
                }
            };
            let platform = Arc::new(desktop::TauriPlatform { app: handle.clone(), last_window: Default::default() });
            app.manage(platform.clone());
            let core = core::Core::new(db, secrets, paths, platform);
            let interrupted = agent::store::mark_interrupted(&core).unwrap_or(0);
            if interrupted > 0 {
                log::warn!("{interrupted} task(s) were interrupted when Lumo last closed");
            }
            let _ = agent::store::apply_retention(&core);
            // A plan may have changed while Lumo was closed; keep only as many automations on as it includes.
            if let Err(e) = plans::pause_excess_automations(&core) {
                log::warn!("plan limits: {e}");
            }
            let registry = Arc::new(tools::Registry::standard());
            app.manage(commands::AppState { core: core.clone(), registry: registry.clone() });

            desktop::build_tray(&handle, &core)?;
            live_icon::start(&handle, core.clone());
            let shortcut = core.settings().global_shortcut;
            if let Err(e) = desktop::register_shortcut(&handle, &shortcut) {
                log::warn!("{e}");
            }
            tauri::async_runtime::spawn(automations::scheduler(core.clone(), registry));
            let s = core.settings();
            if s.onboarded && s.buddy_enabled {
                desktop::set_buddy_visible(&handle, true);
            }

            if let Some(w) = app.get_webview_window("main") {
                let core2 = core.clone();
                let h2 = handle.clone();
                w.on_window_event(move |ev| match ev {
                    tauri::WindowEvent::CloseRequested { api, .. } if core2.settings().close_to_tray => {
                        api.prevent_close();
                        if let Some(w) = h2.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                        let infos: Vec<_> = paths.iter().filter_map(|p| commands::register_attachment(&core2, p)).collect();
                        let _ = h2.emit("files-dropped", infos);
                    }
                    _ => {}
                });
                // Shown by the UI once it has painted, to avoid a blank flash.
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::save_settings,
            commands::secrets_status,
            commands::set_secret,
            commands::delete_secret,
            commands::test_model_connection,
            commands::list_conversations,
            commands::get_conversation,
            commands::rename_conversation,
            commands::delete_conversation,
            commands::start_run,
            commands::cancel_run,
            commands::stop_all_runs,
            commands::resolve_approval,
            commands::answer_question,
            commands::list_active_runs,
            commands::list_runs,
            commands::attach_files,
            commands::list_grants,
            commands::list_capabilities,
            commands::grant_folder,
            commands::grant_capability,
            commands::revoke_grant,
            commands::list_changes,
            commands::undo_run,
            commands::list_memories,
            commands::add_memory,
            commands::update_memory,
            commands::delete_memory,
            commands::delete_all_memories,
            commands::export_memories,
            commands::export_conversation,
            commands::list_automations,
            commands::save_automation,
            commands::delete_automation,
            commands::run_automation,
            commands::list_automation_runs,
            commands::allowable_automation_tools,
            commands::list_agents,
            commands::save_agent,
            commands::delete_agent,
            commands::list_tools,
            commands::list_projects,
            commands::create_project,
            commands::project_files,
            commands::read_project_file,
            commands::write_project_file,
            commands::project_history,
            commands::save_project_version,
            commands::restore_project_version,
            commands::reveal_project,
            commands::list_audit,
            commands::open_logs,
            commands::show_main_window,
            commands::toggle_compact_window,
            commands::buddy_screen,
            commands::buddy_move,
            commands::buddy_hide,
            commands::check_for_updates,
            commands::install_update,
            commands::integrations_status,
            commands::verify_integration,
            commands::disconnect_integration,
            commands::transcribe_audio,
            commands::open_external_url,
            commands::detect_location,
            commands::license_status,
            commands::activate_license,
            commands::remove_license,
            commands::plan_usage,
            commands::model_catalog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lumo");
}
