// The shell guard-pdf-scaled-text.sh drives: a PDF in an <iframe> drawn at
// 0.8 of its size, as a monitor at a lower density than the desk's highest
// shows every page.
//
//   GUARD pdf-frame-loaded
//
// Domicile calls `HostShell` once the module loads.

export const HostShell = (root) => {
  const frame = document.createElement("iframe");
  frame.style.position = "absolute";
  frame.style.left = "0";
  frame.style.top = "0";
  frame.style.border = "0";
  frame.style.inlineSize = "900px";
  frame.style.blockSize = "700px";
  frame.style.transformOrigin = "0 0";
  frame.style.transform = "scale(0.8)";
  frame.addEventListener("load", () => {
    console.log("GUARD pdf-frame-loaded");
  });
  frame.src =
    "domicile://home/guard-pdf-scaled-text.pdf#toolbar=0&navpanes=0&zoom=100";
  root.append(frame);
};
