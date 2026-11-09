//! E2 — Escalabilidad de la búsqueda local de archivos (`search_files`).
//!
//! Mide el recorrido BFS completo, el acierto profundo y el caso «solo
//! carpetas» sobre árboles sintéticos de 1k, 5k y 20k entradas. Los árboles se
//! crean en `%TEMP%` (fuera de OneDrive) para que la sincronización del
//! escritorio no contamine la medición.

use std::fs;
use std::hint::black_box;
use std::path::{Path, PathBuf};

use aster_desktop_assistant_lib::bench_api::{search_files, FileHit};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use tempfile::TempDir;

const LIMIT: u32 = 25;
const DIRS: usize = 40;

struct Tree {
    _dir: TempDir,
    root: PathBuf,
    entries: usize,
}

fn write_file(dir: &Path, name: &str) {
    fs::write(dir.join(name), b"x").expect("no se pudo crear el archivo sintético");
}

/// Construye un árbol reproducible:
/// - `pago.pdf` suelto en la raíz y la carpeta `Andi` (regresiones reales).
/// - Una cadena de 5 niveles y 40 carpetas repartidas en dos niveles.
/// - `entries / 40` documentos por carpeta y un objetivo al final.
/// - Opcionalmente, un `node_modules` que la poda debe evitar recorrer.
fn build_tree(label: &str, entries: usize, node_modules_files: usize) -> Tree {
    let dir = tempfile::Builder::new()
        .prefix(&format!("aster-bench-{label}-"))
        .tempdir()
        .expect("no se pudo crear el directorio temporal");
    let root = dir.path().to_path_buf();

    write_file(&root, "pago.pdf");
    fs::create_dir(root.join("Andi")).expect("no se pudo crear Andi");
    write_file(&root, "Andi.zip");

    let mut deep = root.clone();
    for level in 0..5 {
        deep = deep.join(format!("nivel-{level}"));
        fs::create_dir(&deep).expect("no se pudo crear el nivel");
    }

    let per_dir = (entries / DIRS).max(1);
    let mut created = 0usize;
    for d in 0..DIRS {
        let dir_path = if d % 2 == 0 {
            root.join(format!("grupo-{d:02}"))
        } else {
            deep.join(format!("grupo-{d:02}"))
        };
        fs::create_dir_all(&dir_path).expect("no se pudo crear el grupo");
        for i in 0..per_dir {
            write_file(&dir_path, &format!("documento-{d:02}-{i:05}.pdf"));
            created += 1;
        }
    }
    write_file(&deep, "zz-objetivo.pdf");
    created += 1;

    if node_modules_files > 0 {
        let nm = root.join("node_modules");
        fs::create_dir(&nm).expect("no se pudo crear node_modules");
        for i in 0..node_modules_files {
            write_file(&nm, &format!("dependencia-{i:04}.js"));
            created += 1;
        }
    }

    Tree {
        _dir: dir,
        root,
        entries: created,
    }
}

fn hits(hits: &[FileHit]) -> usize {
    hits.len()
}

fn bench_files(c: &mut Criterion) {
    let trees = [
        ("1k", build_tree("1k", 1_000, 0)),
        ("5k-poda", build_tree("5k-poda", 5_000, 2_000)),
        ("20k", build_tree("20k", 20_000, 0)),
    ];

    // Validación previa: el benchmark debe medir una búsqueda que funciona, no
    // un recorrido que devuelve vacío por un error silencioso.
    for (label, tree) in &trees {
        let none = search_files(std::slice::from_ref(&tree.root), "qqqq-inventado.xyz", LIMIT, false)
            .expect("la búsqueda de validación debe ejecutarse");
        assert!(none.is_empty(), "el árbol {label} no debería tener coincidencias");
    }
    let deep_hit = search_files(
        std::slice::from_ref(&trees[2].1.root),
        "zz-objetivo.pdf",
        LIMIT,
        false,
    )
    .expect("la búsqueda profunda debe ejecutarse");
    assert_eq!(deep_hit.len(), 1, "el objetivo profundo debe encontrarse");
    let folder_hit = search_files(
        std::slice::from_ref(&trees[1].1.root),
        "grupo-39",
        LIMIT,
        true,
    )
    .expect("la búsqueda de carpetas debe ejecutarse");
    assert_eq!(folder_hit.len(), 1, "grupo-39 debe encontrarse como carpeta");
    assert!(folder_hit[0].is_directory, "grupo-39 debe ser una carpeta");

    // Barrido completo: la consulta no existe, así que se inspeccionan todas
    // las entradas permitidas. Es el peor caso y el más estable.
    let mut scan = c.benchmark_group("search_files_barrido");
    scan.sample_size(20);
    for (label, tree) in &trees {
        scan.throughput(Throughput::Elements(tree.entries as u64));
        scan.bench_with_input(
            BenchmarkId::new("completo", label),
            &tree.root,
            |b, root| {
                b.iter(|| {
                    let found =
                        search_files(std::slice::from_ref(root), "qqqq-inventado.xyz", LIMIT, false)
                            .expect("la búsqueda debe ejecutarse");
                    black_box(hits(&found))
                });
            },
        );
    }
    scan.finish();

    // Acierto profundo: el objetivo está al final del árbol de 20k.
    let big = &trees[2].1;
    let mut hit = c.benchmark_group("search_files_acierto");
    hit.sample_size(20);
    hit.throughput(Throughput::Elements(big.entries as u64));
    hit.bench_function("profundo-20k", |b| {
        b.iter(|| {
            let found = search_files(
                std::slice::from_ref(&big.root),
                "zz-objetivo.pdf",
                LIMIT,
                false,
            )
            .expect("la búsqueda debe ejecutarse");
            black_box(hits(&found))
        });
    });
    hit.finish();

    // Solo carpetas: «busca la carpeta grupo-39» (evita devolver Andi.zip).
    let five = &trees[1].1;
    let mut folders = c.benchmark_group("search_files_solo_carpetas");
    folders.sample_size(20);
    folders.throughput(Throughput::Elements(five.entries as u64));
    folders.bench_function("grupo-39-5k-poda", |b| {
        b.iter(|| {
            let found = search_files(
                std::slice::from_ref(&five.root),
                "grupo-39",
                LIMIT,
                true,
            )
            .expect("la búsqueda debe ejecutarse");
            black_box(hits(&found))
        });
    });
    folders.finish();
}

criterion_group!(benches, bench_files);
criterion_main!(benches);
