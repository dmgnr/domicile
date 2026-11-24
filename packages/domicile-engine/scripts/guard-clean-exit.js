// The shell guard-clean-exit.sh drives. Says it is up, so the guard knows
// the browser has finished starting before it ends it:
//
//   GUARD clean-exit ready

export const HostShell = () => {
  console.log("GUARD clean-exit ready");
};
