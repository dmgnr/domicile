// Loads each library named on the command line, as the compositor and the
// engine load the graphics driver: with Domicile's own glibc and every symbol
// bound now. Prints why and exits 1 at the first one that does not load.
//
// The NixOS module runs it on the system's driver at build time
// (`packages/distro/nix/nixos.nix`), so a driver Domicile cannot load fails
// the build instead of the desktop drawing without the graphics card.
#include <dlfcn.h>
#include <stdio.h>

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <library>...\n", argv[0]);
    return 2;
  }
  for (int i = 1; i < argc; i++) {
    if (dlopen(argv[i], RTLD_NOW | RTLD_LOCAL) == NULL) {
      fprintf(stderr, "cannot load %s: %s\n", argv[i], dlerror());
      return 1;
    }
  }
  return 0;
}
