//! Tests for what `domicile --version` says about the engine.

use domicile_launch::version::{engine, VersionError};

const PROVENANCE: &str = "\
domicile engine, packaged on crux
series identity: 2ffe1826ced063451b7a0baa54f0ddf6c851b238e3caa06ecf19757a73649b28
domicile commit: 246fa60eff4e64a6b0eb095442c9f89681b1f4cb
chromium pin:    7703634
built:           2026-11-15T09:12:44Z
build:           official (is_official_build = true, dcheck_always_on = false)
gn args:         see .github/scripts/engine-release-build.sh at the commit above

libdomicile_engine.so is dlopened by domicile-compositor by name, so this
directory has to be on its LD_LIBRARY_PATH.
";

#[test]
fn the_engine_is_its_release_flavor_chromium_and_commit() {
    assert_eq!(
        engine(PROVENANCE),
        Ok("engine   s2ffe1826ced0, official build of Chromium 7703634 at 246fa60eff4e, built 2026-11-15T09:12:44Z".to_string())
    );
}

#[test]
fn a_provenance_missing_a_field_names_it() {
    assert_eq!(
        engine(&PROVENANCE.replace("chromium pin:", "pin:")),
        Err(VersionError::NoField {
            field: "chromium pin"
        })
    );
}
