# NixOS with Domicile

A minimal flake that installs Domicile on a NixOS machine and runs manganese
for one user, with home-manager.

- `flake.nix` passes `domicile` to both modules.
- `configuration.nix` adds the login session and the lock screen's password
  check, and Domicile's binary cache.
- `hardware-configuration.nix` is your machine's, from `nixos-generate-config`.
- `home.nix` writes the user's config file and picks the shell.

`nix flake check` in this repository evaluates `configuration.nix` and
`home.nix` (the `nixos-example` check).
