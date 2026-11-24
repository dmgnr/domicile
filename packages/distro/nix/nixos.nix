# NixOS module for the machine-level parts of a Domicile desk.
#
# `packages/distro/nix/home-manager.nix` configures the desk itself. This module
# provides the `domicile` login session and its user units, the PAM service
# the lock uses, UPower for the battery, portal routing, rtkit, and the
# `domicile` group whose sessions may raise the engine's frame threads. See
# docs/RUNNING-A-DESKTOP.md#on-nixos.
#
# The session runs whichever shell the config names. The module sets no
# default session and enables no display manager; set
# `services.displayManager.defaultSession = "domicile"` for that.
#
# Curried so `domicilePackages` can supply this flake's package defaults.
{domicilePackages}: {
  lib,
  pkgs,
  config,
  ...
}: let
  cfg = config.programs.domicile;
in {
  imports = [
    (lib.mkRemovedOptionModule ["programs" "domicile" "desktops"] ''
      There is one session, `domicile`, which runs the shell the config names:
      set `"shell"` in ~/.config/domicile/domicile.json (`programs.domicile.shell`
      in the home-manager module) instead.
    '')
  ];

  options.programs.domicile = {
    enable = lib.mkEnableOption "the `domicile` login session, and the PAM service a desk's lock opens through";

    package = lib.mkOption {
      description = ''
        The package providing the `domicile` session, Domicile's portal
        backend and its routing.
      '';
      type = lib.types.package;
      default = domicilePackages.domicile;
      defaultText = lib.literalExpression "domicile.packages.\${system}.domicile";
    };

    miracast = lib.mkOption {
      description = ''
        Whether to set up casting to Miracast TVs: open TCP port 7236, which
        a TV connects back to as a cast starts, and run Avahi, which finds TVs
        on the LAN.
      '';
      type = lib.types.bool;
      default = true;
    };
  };

  config = lib.mkIf cfg.enable {
    services.displayManager.sessionPackages = [cfg.package];

    # The compositor and the engine load the system's driver, from
    # /run/opengl-driver, with Domicile's own glibc. A driver built against a
    # newer glibc does not load, and the desktop would draw without the
    # graphics card. So the system build loads it the same way first, and
    # fails saying how to fix it.
    system.checks = lib.mkIf config.hardware.graphics.enable [
      (pkgs.runCommand "domicile-loads-the-graphics-driver" {} ''
        ${cfg.package}/libexec/domicile/graphics-probe \
          ${config.hardware.graphics.package}/lib/libEGL_mesa.so.0 \
          ${config.hardware.graphics.package}/lib/gbm/dri_gbm.so || {
          echo "Domicile cannot load this system's graphics driver, so it would draw" >&2
          echo "without the graphics card. This happens when Domicile is built from an" >&2
          echo "older nixpkgs than the system. Build it from yours: in your flake, set" >&2
          echo '  inputs.domicile.inputs.nixpkgs.follows = "nixpkgs";' >&2
          exit 1
        }
        touch "$out"
      '')
    ];

    # Installs `domicile-session.target`, which starts
    # `graphical-session.target` and so the portal.
    systemd.packages = [cfg.package];

    # The portal runs outside the desk and finds `domicile-mimeapps.list` only
    # on the system profile. It is read only when `XDG_CURRENT_DESKTOP` is
    # `domicile`.
    environment.systemPackages = [cfg.package];

    # Read by `@domicile-desktop/system-battery`, so manganese's bar and lock
    # screen show the battery. NixOS enables it only for desktops that ask.
    services.upower.enable = lib.mkDefault true;

    # Raises the compositor's and the engine's frame threads for a user
    # outside the `domicile` group. See
    # docs/RUNNING-A-DESKTOP.md#thread-priorities.
    security.rtkit.enable = lib.mkDefault true;

    # The accessibility bus: screen readers, and `domicile accessibility`,
    # which agents read and drive native apps with. NixOS enables it only for
    # desktops that ask.
    services.gnome.at-spi2-core.enable = lib.mkDefault true;

    # `domicile-miracast`: the TV opens RTSP to this computer, and LAN TVs are
    # found over mDNS.
    networking.firewall.allowedTCPPorts = lib.mkIf cfg.miracast [7236];
    services.avahi.enable = lib.mkIf cfg.miracast (lib.mkDefault true);

    # The PAM service that unlocks a desk unless `lock.pam_service` names
    # another. Without it, a locked desk opens to nothing.
    security.pam.services.domicile = {};

    # The engine and compositor ask for nice -8 on the threads that draw and
    # present frames. The engine asks for SCHED_RR 8 on its realtime audio
    # threads, falling back to nice -10.
    # Without these limits each request goes to rtkit, which may refuse a
    # burst. Granted to a group, as NixOS's PipeWire and JACK modules do. Listed first (`mkBefore`) because a later pam_limits line for another
    # group overrides an earlier one, so a larger grant such as PipeWire's wins.
    users.groups.domicile = {};
    security.pam.loginLimits = lib.mkBefore [
      {
        domain = "@domicile";
        type = "-";
        item = "nice";
        value = -10;
      }
      {
        domain = "@domicile";
        type = "-";
        item = "rtprio";
        value = 8;
      }
    ];

    # Takes effect only when `xdg.portal.enable` is set. Domicile is the only
    # backend; `domicile-portals.conf` sends `Secret` to the keyring, which
    # the user installs.
    xdg.portal = {
      extraPortals = [cfg.package];
      configPackages = [cfg.package];
    };
  };
}
