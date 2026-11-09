// Evita que se abra una consola detrás de la aplicación en Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aster_desktop_assistant_lib::run()
}
