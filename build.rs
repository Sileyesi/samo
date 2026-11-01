// Linux: let the binary find libcef.so next to itself. Windows: embed the app icon.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux") => println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN"),
        #[cfg(windows)]
        Ok("windows") => {
            println!("cargo:rerun-if-changed=packaging/icons/samo.ico");
            let mut res = winresource::WindowsResource::new();
            res.set_icon("packaging/icons/samo.ico");
            res.compile().expect("failed to embed Windows resources");
        }
        _ => {}
    }
}
