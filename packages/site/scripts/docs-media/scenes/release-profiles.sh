# Release notes: a page in a browser profile, its button at the start of the
# address bar, and the profile menu open from it.

config '{
  "browser": {
    "profiles": {
      "personal": { "name": "Personal", "color": "#0d9488" },
      "work": { "name": "Work", "color": "#d97706" },
      "private": { "name": "Private", "color": "#a78bfa", "private": true }
    },
    "default_profile": "personal",
    "sites": { "github.com": "work" }
  }
}'
desktop @domicile-desktop/manganese
"$DOMICILE_BIN" open https://github.com/cprussin/domicile
settle 10
shot release-profiles-closed
click 130 88
settle 2
shot release-profiles
