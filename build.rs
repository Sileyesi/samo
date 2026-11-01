// Let the binary find libcef.so next to itself (scripts/run.sh symlinks the CEF runtime there).
fn main() {
    println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN");
    println!("cargo:rerun-if-changed=build.rs");
}
