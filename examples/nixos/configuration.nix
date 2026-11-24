{ domicile, ... }:
{
  imports = [ domicile.nixosModules.default ];

  programs.domicile.enable = true;
  services.displayManager.defaultSession = "domicile";
  services.displayManager.gdm.enable = true;

  # Download Domicile from its binary cache instead of building it.
  nix.settings = {
    substituters = [ "https://packages.domicile-desktop.com/nix" ];
    trusted-public-keys = [ "packages.domicile-desktop.com-1:iAulr298MtC52WMi2GPI8bqPEvOXHoQtSRAGOo0ny90=" ];
  };

  users.users.you = {
    isNormalUser = true;
    extraGroups = [ "domicile" ];
  };

  system.stateVersion = "25.11";
}
