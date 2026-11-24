# Settings the compositor no longer reads, as hidden options and assertions.
#
# `removed` maps a dotted path into `programs.domicile.settings` to where the
# setting went. `[]` steps into a list's elements:
# `output.profiles[].displays[].mode`, and `*` into a map's values:
# `extensions.settings.*.private`. Each path becomes a hidden option that
# defaults to `null`, and setting one fails an assertion with its note.
{lib}: removed: let
  steps = lib.splitString ".";

  hidden = lib.mkOption {
    visible = false;
    type = lib.types.nullOr lib.types.anything;
    default = null;
  };

  # Every value at `path` in `settings`, from each element of a list.
  valuesAt = path: settings:
    lib.foldl' (values: step:
      lib.concatMap (value:
        if lib.hasSuffix "[]" step
        then value.${lib.removeSuffix "[]" step} or []
        else if step == "*"
        then lib.optionals (lib.isAttrs value) (lib.attrValues value)
        else lib.optional (lib.isAttrs value && value ? ${step}) value.${step})
      values) [settings] (steps path);
in {
  # The hidden options for a submodule at `prefix` ("" for `settings`): the
  # paths under it that step into no list or map below it.
  optionsUnder = prefix: let
    under = path:
      if prefix == ""
      then path
      else lib.removePrefix "${prefix}." path;
    here = path:
      (prefix == "" || lib.hasPrefix "${prefix}." path)
      && !(lib.hasInfix "[]" (under path))
      && !(lib.elem "*" (steps (under path)));
  in
    lib.foldl' lib.recursiveUpdate {}
    (map (path: lib.setAttrByPath (steps (under path)) hidden)
      (lib.filter here (lib.attrNames removed)));

  # One assertion per path, failing when any value at it is set.
  assertions = settings:
    lib.mapAttrsToList (path: note: {
      assertion = lib.all (value: value == null) (valuesAt path settings);
      message = "programs.domicile.settings.${path} is removed. ${note}";
    })
    removed;
}
