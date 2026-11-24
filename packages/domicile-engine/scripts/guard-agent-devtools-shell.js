// The shell guard-agent-devtools-shell.sh drives: one button, which an
// agent's `devtools shell` must find in the shell page's accessibility tree.

export const HostShell = (root) => {
  const button = document.createElement("button");
  button.textContent = "GUARD agent button";
  root.append(button);
  console.log("GUARD agent-shell ready");
};
