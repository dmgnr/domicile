# Release notes: Settings' Profiles page.

config '{
  "extensions": { "web_store": ["ddkjiahejlhfcafbddmgiahcphecmpfh"] },
  "browser": {
    "profiles": {
      "personal": { "name": "Personal", "color": "#0d9488" },
      "work": { "name": "Work", "color": "#d97706" },
      "private": { "name": "Private", "color": "#a78bfa", "private": true }
    },
    "default_profile": "personal",
    "default_private_profile": "private",
    "sites": { "github.com": "work", "*.atlassian.net": "work" }
  }
}'
desktop @domicile-desktop/manganese
"$(dirname "$DOMICILE_BIN")/domicile-settings"
settle 8
# Profiles, in the sidebar.
click 95 509
settle 3
shot release-profiles-settings
