//! Acción 3 del catálogo: información del sistema.
//!
//! Solo se recoge información de lectura. No se enumeran variables de entorno,
//! ni claves del registro, ni rutas del perfil: el informe es un resumen de
//! hardware pensado para que el asistente responda en voz alta.
use sysinfo::{CpuRefreshKind, Disks, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

use crate::model::{human_duration, human_size, now_iso, DiskReport, ProcessReport, SystemReport};
use crate::screen::count_screens;
use crate::win::battery_report;

/// Número de procesos que se devuelven, ordenados por memoria.
const TOP_PROCESSES: usize = 8;

/// Genera el informe del sistema.
///
/// `detail` es la parte que el usuario preguntó («memoria», «discos»…). Se usa
/// para recortar el trabajo: no tiene sentido recorrer la lista de procesos si
/// solo preguntaron por el disco.
pub fn build_report(detail: Option<&str>) -> Result<SystemReport, String> {
    let focus = detail.unwrap_or_default().to_lowercase();
    let wants_processes =
        focus.contains("proceso") || focus.contains("programa") || focus.contains("tarea");

    let mut system = System::new_with_specifics(
        RefreshKind::nothing()
            .with_memory(sysinfo::MemoryRefreshKind::everything())
            .with_cpu(sysinfo::CpuRefreshKind::nothing()),
    );
    system.refresh_memory();

    let total = system.total_memory();
    let available = system.available_memory();
    let used_percent = if total > 0 {
        ((total.saturating_sub(available)) as f64 / total as f64 * 100.0) as f32
    } else {
        0.0
    };

    let processes = if wants_processes {
        collect_processes(&mut system)
    } else {
        Vec::new()
    };

    Ok(SystemReport {
        os_name: System::name().unwrap_or_else(|| "Windows".to_string()),
        os_version: System::long_os_version()
            .or_else(System::os_version)
            .unwrap_or_default(),
        build: System::kernel_version().unwrap_or_default(),
        architecture: {
            let arch = System::cpu_arch();
            if arch.trim().is_empty() {
                "x64".to_string()
            } else {
                arch
            }
        },
        hostname: System::host_name().unwrap_or_else(|| "equipo".to_string()),
        user: crate::model::whoami(),
        cpu: cpu_brand(),
        cpu_threads: system.cpus().len(),
        memory_total_bytes: total,
        memory_available_bytes: available,
        memory_used_percent: (used_percent * 10.0).round() / 10.0,
        uptime_seconds: System::uptime(),
        uptime_label: human_duration(System::uptime()),
        battery: battery_report(),
        disks: collect_disks(),
        screens: count_screens(),
        processes,
        generated_at: now_iso(),
    })
}

/// Marca comercial del procesador.
fn cpu_brand() -> String {
    // `CpuRefreshKind::everything()` incluye la marca del CPU; `nothing()` la deja
    // en "unknown" y obligaría a mostrar unProcessor desconocido.
    let mut system =
        System::new_with_specifics(RefreshKind::nothing().with_cpu(CpuRefreshKind::everything()));
    system.refresh_cpu_all();
    system
        .cpus()
        .iter()
        .find(|cpu| !cpu.brand().eq_ignore_ascii_case("unknown"))
        .map(|cpu| cpu.brand().to_string())
        .unwrap_or_else(|| "Desconocido".to_string())
}

/// Unidades con al menos 1 GB libre, para no saturar la respuesta hablada.
fn collect_disks() -> Vec<DiskReport> {
    let mut disks: Vec<DiskReport> = Disks::new_with_refreshed_list()
        .list()
        .iter()
        .filter(|disk| disk.total_space() > 0)
        .filter_map(|disk| {
            let total = disk.total_space();
            let free = disk.available_space();
            let mount = disk.mount_point().to_string_lossy().to_string();
            let letter = mount
                .chars()
                .take_while(|c| c.is_alphanumeric())
                .collect::<String>();
            let kind = format!("{:?}", disk.kind());
            let label = if disk.name().to_string_lossy().trim().is_empty() {
                if letter.is_empty() {
                    kind
                } else {
                    format!("{letter} ({kind})")
                }
            } else {
                format!("{} ({})", disk.name().to_string_lossy(), kind)
            };
            Some(DiskReport {
                letter: if letter.is_empty() {
                    mount.clone()
                } else {
                    letter
                },
                label,
                total_bytes: total,
                free_bytes: free,
                used_percent: if total > 0 {
                    ((((total - free) as f64 / total as f64) * 1000.0).round() / 10.0) as f32
                } else {
                    0.0
                },
                total_label: human_size(total),
                free_label: human_size(free),
            })
        })
        .collect();

    disks.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes));
    disks.truncate(6);
    disks
}

/// Procesos que más memoria consumen.
fn collect_processes(system: &mut System) -> Vec<ProcessReport> {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );

    let mut rows: Vec<ProcessReport> = system
        .processes()
        .values()
        .filter(|process| process.memory() > 0)
        .map(|process| ProcessReport {
            pid: process.pid().as_u32(),
            name: process.name().to_string_lossy().to_string(),
            memory_bytes: process.memory(),
            memory_label: human_size(process.memory()),
        })
        .collect();

    rows.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));
    rows.truncate(TOP_PROCESSES);
    rows
}

/// Punto de entrada IPC: informe del sistema.
#[tauri::command]
pub fn system_report(detail: Option<String>) -> Result<SystemReport, String> {
    build_report(detail.as_deref())
}
