//! What a shell argument names: a module, an entry, Domicile's own, or a
//! package.

use std::path::{Path, PathBuf};

use domicile_launch::shell_path::{Shell, ShellFiles, ShellPathError};
use domicile_launch::shell_source::{imports_a_package, shell_source, ShellSource};

const HERE: &str = "/home/me/desk";

fn source(argument: &str, files: &[(&str, &str)]) -> Result<ShellSource, ShellPathError> {
    let files: Vec<(PathBuf, String)> = files
        .iter()
        .map(|(path, text)| (PathBuf::from(path), text.to_string()))
        .collect();
    shell_source(
        argument,
        None,
        Path::new(HERE),
        Some(Path::new("/home/me")),
        &|path| files.iter().any(|(file, _)| file == path).then_some(false),
        &|path| {
            files
                .iter()
                .find(|(file, _)| file == path)
                .map(|(_, text)| text.clone())
        },
    )
}

#[test]
fn domicile_s_own_shells_are_named_and_never_built() {
    assert_eq!(
        source("@domicile-desktop/manganese", &[]),
        Ok(ShellSource::Ours("manganese".into()))
    );
}

#[test]
fn a_bundle_is_served_as_it_is() {
    assert_eq!(
        source(
            "./dist/shell.js",
            &[(
                "/home/me/desk/dist/shell.js",
                r#"import{a}from"./chunk.js";export{a as Shell}"#
            )]
        ),
        Ok(ShellSource::Module(Shell {
            files: ShellFiles::Directory,
            root: "/home/me/desk/dist".into(),
            module: "shell.js".into(),
        }))
    );
}

#[test]
fn typescript_is_built() {
    assert_eq!(
        source("domicile.tsx", &[("/home/me/desk/domicile.tsx", "")]),
        Ok(ShellSource::Entry("/home/me/desk/domicile.tsx".into()))
    );
}

#[test]
fn javascript_that_imports_a_package_is_built() {
    assert_eq!(
        source(
            "./entry.js",
            &[(
                "/home/me/desk/entry.js",
                r#"import { runManganese } from "@domicile-desktop/manganese";"#
            )]
        ),
        Ok(ShellSource::Entry("/home/me/desk/entry.js".into()))
    );
}

#[test]
fn a_package_or_a_repository_is_installed() {
    assert_eq!(
        source("github:cprussin/my-cool-shell", &[]),
        Ok(ShellSource::Package("github:cprussin/my-cool-shell".into()))
    );
    assert_eq!(
        source("my-cool-shell", &[]),
        Ok(ShellSource::Package("my-cool-shell".into()))
    );
    assert_eq!(
        source("@someone/shell", &[]),
        Ok(ShellSource::Package("@someone/shell".into()))
    );
}

#[test]
fn a_word_that_is_a_file_where_it_was_typed_is_the_file() {
    assert_eq!(
        source(
            "shell.js",
            &[("/home/me/desk/shell.js", "export const Shell = () => {};")]
        ),
        Ok(ShellSource::Module(Shell {
            files: ShellFiles::Directory,
            root: "/home/me/desk".into(),
            module: "shell.js".into(),
        }))
    );
}

#[test]
fn a_packaged_desktop_s_module_is_its_own() {
    // The wrapper hands over the module and passes its name, so the name is
    // never a package.
    assert_eq!(
        shell_source(
            "manganese",
            Some("/nix/store/x-page/shell.js"),
            Path::new(HERE),
            None,
            &|path| (path == Path::new("/nix/store/x-page/shell.js")).then_some(false),
            &|path| (path == Path::new("/nix/store/x-page/shell.js")).then(String::new),
        ),
        Ok(ShellSource::Module(Shell {
            files: ShellFiles::Directory,
            root: "/nix/store/x-page".into(),
            module: "shell.js".into(),
        }))
    );
}

#[test]
fn only_a_bare_specifier_is_a_package_import() {
    assert!(imports_a_package(r#"import x from "zod";"#));
    assert!(imports_a_package("import 'react';"));
    assert!(imports_a_package(r#"const m = await import("date-fns");"#));
    assert!(!imports_a_package(
        r#"import x from "./x.js"; import y from "/y.js";"#
    ));
    assert!(!imports_a_package(r#"import x from "https://esm.sh/zod";"#));
    assert!(!imports_a_package("export const importance = 1;"));
}

/// From manganese's bundle, which a checkout has no builder to rebuild.
#[test]
fn a_keyword_inside_a_longer_word_is_no_import() {
    assert!(!imports_a_package(
        r#"const s = {"--restack-from":e.from,"--restack-to":e.to};"#
    ));
    assert!(imports_a_package(r#"import{a}from"zod";"#));
}

/// mecattaf's prebuilt shell, refused where there was no builder (#2169).
#[test]
fn text_that_reads_like_an_import_is_no_import() {
    assert!(!imports_a_package(
        r#"export const Shell = root => { root.textContent = "Turn on notifications from 'fixture'"; };"#
    ));
    assert!(!imports_a_package("const s = `import 'react'`;"));
    assert!(!imports_a_package(
        "// import x from 'zod';\n/* import('zod') */"
    ));
}

#[test]
fn a_re_export_of_a_package_is_a_package_import() {
    assert!(imports_a_package(r#"export * from "zod";"#));
    assert!(imports_a_package(r#"export { a } from "zod";"#));
    assert!(!imports_a_package(r#"export { a } from "./a.js";"#));
}

#[test]
fn only_a_literal_dynamic_import_names_a_package() {
    assert!(imports_a_package("import(`zod`);"));
    assert!(!imports_a_package(r#"import("./chunk.js");"#));
    assert!(!imports_a_package(
        "import(new URL('x', import.meta.url).href);"
    ));
}

#[test]
fn javascript_its_package_json_names_as_the_shell_is_served_as_it_is() {
    // `"domicile": { "shell": ... }` says the module is prebuilt, so it is
    // never scanned or built (#2468).
    assert_eq!(
        source(
            "./dist/shell.js",
            &[
                (
                    "/home/me/desk/package.json",
                    r#"{"domicile":{"shell":"./dist/shell.js"}}"#
                ),
                (
                    "/home/me/desk/dist/shell.js",
                    r#"import x from "zod"; export const Shell = x;"#
                ),
            ]
        ),
        Ok(ShellSource::Module(Shell {
            files: ShellFiles::Directory,
            root: "/home/me/desk/dist".into(),
            module: "shell.js".into(),
        }))
    );
}

#[test]
fn a_directory_s_named_module_is_never_built() {
    // `dist/package.json` is nearer the module, and names no shell.
    let files = [
        (
            "/home/me/desk/package.json",
            r#"{"domicile":{"shell":"dist/shell.js"}}"#,
        ),
        ("/home/me/desk/dist/package.json", r#"{"type":"module"}"#),
        ("/home/me/desk/dist/shell.js", r#"import x from "zod";"#),
    ];
    assert_eq!(
        shell_source(
            "./desk",
            None,
            Path::new("/home/me"),
            None,
            &|path| match path.to_str() {
                Some("/home/me/desk") => Some(true),
                _ => files
                    .iter()
                    .any(|(file, _)| Path::new(file) == path)
                    .then_some(false),
            },
            &|path| {
                files
                    .iter()
                    .find(|(file, _)| Path::new(file) == path)
                    .map(|(_, text)| text.to_string())
            },
        ),
        Ok(ShellSource::Module(Shell {
            files: ShellFiles::Directory,
            root: "/home/me/desk/dist".into(),
            module: "shell.js".into(),
        }))
    );
}

#[test]
fn a_package_json_with_other_domicile_fields_names_no_shell() {
    assert_eq!(
        source(
            "./entry.js",
            &[
                ("/home/me/desk/package.json", r#"{"domicile":{"other":1}}"#),
                ("/home/me/desk/entry.js", r#"import x from "zod";"#),
            ]
        ),
        Ok(ShellSource::Entry("/home/me/desk/entry.js".into()))
    );
}

#[test]
fn a_package_json_naming_another_module_leaves_the_scan_to_decide() {
    assert_eq!(
        source(
            "./src/entry.js",
            &[
                (
                    "/home/me/desk/package.json",
                    r#"{"domicile":{"shell":"dist/shell.js"}}"#
                ),
                ("/home/me/desk/src/entry.js", r#"import x from "zod";"#),
            ]
        ),
        Ok(ShellSource::Entry("/home/me/desk/src/entry.js".into()))
    );
}

/// What a minified Vite bundle holds (#2468).
#[test]
fn import_meta_and_keywords_in_strings_are_no_import() {
    assert!(!imports_a_package(
        r#"const u=new URL("a.wasm",import.meta.url),s="export default x",t='import y from "z"';export{u as Shell};"#
    ));
}

#[test]
fn javascript_the_browser_cannot_parse_is_built() {
    assert_eq!(
        source(
            "./entry.js",
            &[(
                "/home/me/desk/entry.js",
                "export const Shell = () => <div />;"
            )]
        ),
        Ok(ShellSource::Entry("/home/me/desk/entry.js".into()))
    );
}
