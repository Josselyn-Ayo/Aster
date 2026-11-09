//! Ping mínimo a Atlas con la URI del `.env` (`MONGODB_URI`).
//!
//! Uso: `cargo run --example mongo_ping` desde `src-tauri/`.
//! Aísla la conexión del resto de la app para diagnosticar DNS/auth/red.
//! Nunca imprime la URI ni la contraseña, solo el resultado por etapas.
//!
//! Para `mongodb+srv://` resuelve el SRV con DNS públicos explícitos (el
//! resolver del sistema de Windows puede colgarse), igual que `db.rs`.
use mongodb::bson::doc;
use mongodb::options::{ClientOptions, ResolverConfig};

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    let uri = match std::env::var("MONGODB_URI") {
        Ok(u) if !u.trim().is_empty() => u,
        _ => {
            eprintln!("Sin MONGODB_URI en el entorno ni en .env.");
            std::process::exit(2);
        }
    };
    let is_srv = uri
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("mongodb+srv://");
    eprintln!("Etapa 1/2: resolviendo DNS y creando cliente (timeout 20 s)...");

    let opts = if is_srv {
        let mut last = String::new();
        let mut found = None;
        for (name, cfg) in [
            ("Google 8.8.8.8", ResolverConfig::google()),
            ("Cloudflare 1.1.1.1", ResolverConfig::cloudflare()),
        ] {
            match tokio::time::timeout(
                std::time::Duration::from_secs(10),
                ClientOptions::parse_with_resolver_config(&uri, cfg),
            )
            .await
            {
                Ok(Ok(o)) => {
                    eprintln!("SRV resuelto con DNS {name}: {} seed(s).", o.hosts.len());
                    found = Some(o);
                    break;
                }
                Ok(Err(e)) => {
                    eprintln!("SRV con DNS {name} falló: {e}");
                    last = e.to_string();
                }
                Err(_) => {
                    eprintln!("SRV con DNS {name} agotó 10 s.");
                    last = format!("{name}: tiempo de espera");
                }
            }
        }
        match found {
            Some(o) => o,
            None => {
                eprintln!("No se pudo resolver el SRV (DNS públicos: {last}).");
                std::process::exit(1);
            }
        }
    } else {
        match tokio::time::timeout(
            std::time::Duration::from_secs(20),
            ClientOptions::parse(&uri),
        )
        .await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                eprintln!("Parse/URI falló: {e}");
                std::process::exit(1);
            }
            Err(_) => {
                eprintln!("El parse agotó 20 s.");
                std::process::exit(1);
            }
        }
    };

    let client = match mongodb::Client::with_options(opts) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Cliente falló: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("Etapa 2/2: ping a admin (timeout 15 s)...");
    match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        client.database("admin").run_command(doc! {"ping": 1}, None),
    )
    .await
    {
        Ok(Ok(_)) => println!("Ping OK: conectado a MongoDB Atlas."),
        Ok(Err(e)) => {
            eprintln!("Ping falló (auth, IP allowlist o cluster pausado): {e}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("Ping agotó 15 s (firewall o IP no autorizada).");
            std::process::exit(1);
        }
    }
}
