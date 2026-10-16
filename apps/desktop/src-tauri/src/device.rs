//! What the device Lumo runs on can do. The same core builds for computers (Windows, macOS, Linux)
//! and phones (iOS, Android); this is the one place that says which features exist where, so the
//! agent, the plans and the UI ask here instead of checking the OS themselves.
//!
//! Phones have no tray, global shortcut, floating window or installer updates (the app stores
//! update them), they don't let apps capture or control the screen, and they can't run arbitrary
//! programs.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FormFactor {
    Desktop,
    Phone,
}

/// Features that differ between computers and phones. Sent to the UI with `app_info`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCaps {
    pub form_factor: FormFactor,
    /// Screenshots, mouse and keyboard control, and reading the front window's title.
    pub computer_control: bool,
    /// Running developer commands (`run_command`).
    pub run_commands: bool,
    /// Moving files to the system Trash or Recycle Bin.
    pub system_trash: bool,
    /// Tray or menu bar icon, and closing the window to it.
    pub tray: bool,
    /// A global keyboard shortcut and the floating compact window it opens.
    pub global_shortcut: bool,
    /// Lumo updates itself; on phones the app store does.
    pub self_update: bool,
    /// Choosing any folder on the device for Lumo to work in.
    pub folder_picker: bool,
}

impl DeviceCaps {
    pub const DESKTOP: DeviceCaps = DeviceCaps {
        form_factor: FormFactor::Desktop,
        computer_control: true,
        run_commands: true,
        system_trash: true,
        tray: true,
        global_shortcut: true,
        self_update: true,
        folder_picker: true,
    };

    pub const PHONE: DeviceCaps = DeviceCaps {
        form_factor: FormFactor::Phone,
        computer_control: false,
        run_commands: false,
        system_trash: false,
        tray: false,
        global_shortcut: false,
        self_update: false,
        folder_picker: false,
    };

    /// Whether the agent may be given this tool on this device. Tools not listed exist everywhere.
    pub fn allows_tool(&self, name: &str) -> bool {
        match name {
            "take_screenshot" | "active_window" | "control_computer" => self.computer_control,
            "run_command" => self.run_commands,
            "move_to_trash" => self.system_trash,
            "request_folder_access" => self.folder_picker,
            _ => true,
        }
    }

    /// How the device is named to the user and the model.
    pub fn noun(&self) -> &'static str {
        match self.form_factor {
            FormFactor::Desktop => "computer",
            FormFactor::Phone => "phone",
        }
    }
}

/// The device this build runs on.
pub const fn current() -> DeviceCaps {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        DeviceCaps::PHONE
    } else {
        DeviceCaps::DESKTOP
    }
}

/// The operating system's name as people say it.
pub fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        "ios" => "iOS",
        "android" => "Android",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phones_leave_out_screen_control_commands_and_trash() {
        let p = DeviceCaps::PHONE;
        for t in ["take_screenshot", "active_window", "control_computer", "run_command", "move_to_trash", "request_folder_access"] {
            assert!(!p.allows_tool(t), "{t}");
            assert!(DeviceCaps::DESKTOP.allows_tool(t), "{t}");
        }
        for t in ["read_file", "fetch_url", "find_places", "remember", "notify", "ask_user"] {
            assert!(p.allows_tool(t), "{t}");
        }
    }

    #[test]
    fn this_build_is_a_desktop_build() {
        assert_eq!(current(), DeviceCaps::DESKTOP);
    }
}
