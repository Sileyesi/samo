//! Embeds every `../../themes/*.css` as a built-in theme (`$OUT_DIR/builtin_themes.rs`).

use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dir = manifest.join("../../themes");
    println!("cargo:rerun-if-changed=build.rs");
    // A missing dir makes cargo rerun this script every build, so it is picked up once created.
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut files: Vec<(String, PathBuf)> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "css"))
        .filter_map(|p| {
            let id = p.file_stem()?.to_str()?.to_string();
            let abs = fs::canonicalize(&p).ok()?;
            Some((id, abs))
        })
        .collect();
    files.sort();

    let mut out = String::from(
        "/// (id, css) of the built-in themes, embedded at compile time.\npub static BUILTIN: &[(&str, &str)] = &[\n",
    );
    for (id, path) in &files {
        out.push_str(&format!(
            "    ({id:?}, include_str!({:?})),\n",
            path.display().to_string()
        ));
    }
    out.push_str("];\n");
    let dest = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("builtin_themes.rs");
    fs::write(dest, out).expect("write builtin_themes.rs");
}
