//! What an Electron app's wrapper scripts give the program they end in: the
//! environment and the arguments, for `domicile open --electron` to give
//! `electron-host` instead. See "Running an app" in
//! `docs/architecture/ELECTRON-APPS.md`.
//!
//! Packages start Electron through scripts that set what the app needs:
//! nixpkgs' `makeWrapper` adds a library to `LD_PRELOAD`, programs to `PATH`,
//! flags to the command line. Reading those scripts would mean knowing every
//! way of writing them. Running them doesn't: each runs with `BASH_ENV`
//! naming a script that replaces bash's `exec` with a function. An `exec` of
//! another script lets it run, the same way; the `exec` of a program execs
//! `domicile` instead, given [`RECORD`] and the program's command line,
//! which records them and the environment it got ([`record`]) and exits.

use std::ffi::OsString;
use std::fs;
use std::io::Read as _;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The variables this module sets to follow the wrappers, which the app
/// doesn't get.
const OURS: [&str; 4] = [
    "BASH_ENV",
    "DOMICILE_ELECTRON_BASH",
    "DOMICILE_ELECTRON_LAUNCH",
    "DOMICILE_ELECTRON_RECORDER",
];

/// The first argument that makes `domicile` record a launch, which only the
/// wrappers' `exec` passes.
pub const RECORD: &str = "--record-electron-launch";

/// Sourced by every bash script the wrappers run. `exec` with only
/// redirections still applies them, as bash's own does.
const FOLLOW: &str = r##"
export DOMICILE_ELECTRON_BASH="$BASH"
exec() {
  if [ $# -eq 0 ]; then builtin exec; return; fi
  while [ $# -gt 0 ]; do
    case "$1" in
      -a) shift 2 ;;
      -c|-l|-cl|-lc) shift ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  local start=""
  IFS= read -r -n 2 start < "$1" 2>/dev/null || true
  if [ "$start" = "#!" ]; then builtin exec "$@"; fi
  builtin exec "$DOMICILE_ELECTRON_RECORDER" --record-electron-launch "$@"
}
"##;

/// What a compiled wrapper's `makeCWrapper` command does, as bash: what the
/// C it compiles to does, flag by flag, ending in an `exec` that [`FOLLOW`]
/// catches. The command follows it, then `"$@"` is the wrapper's arguments.
const MAKE_C_WRAPPER: &str = r##"
makeCWrapper() {
  local program="$1" before=() after=() flags
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --set) export "$2=$3"; shift 3 ;;
      --set-default) [ -n "${!2+set}" ] || export "$2=$3"; shift 3 ;;
      --unset) unset "$2"; shift 2 ;;
      --prefix|--prefix-unchecked)
        if [ -n "${!2:-}" ]; then export "$2=$4$3${!2}"; else export "$2=$4"; fi
        shift 4 ;;
      --suffix|--suffix-unchecked)
        if [ -n "${!2:-}" ]; then export "$2=${!2}$3$4"; else export "$2=$4"; fi
        shift 4 ;;
      --chdir) cd "$2" || exit 1; shift 2 ;;
      --add-flag) before+=("$2"); shift 2 ;;
      --append-flag) after+=("$2"); shift 2 ;;
      --add-flags) read -ra flags <<< "$2"; before+=("${flags[@]}"); shift 2 ;;
      --append-flags) read -ra flags <<< "$2"; after+=("${flags[@]}"); shift 2 ;;
      --argv0) shift 2 ;;
      --inherit-argv0|--resolve-argv0) shift ;;
      *) echo "domicile: makeCWrapper has no $1" >&2; exit 1 ;;
    esac
  done
  exec "$program" "${before[@]}" "${WRAPPER_ARGS[@]}" "${after[@]}"
}
WRAPPER_ARGS=("$@")
set --
"##;

/// The largest file read as a compiled wrapper, which is tens of kilobytes.
const COMPILED_WRAPPER_MAX: u64 = 4 << 20;

/// The `makeCWrapper` command a compiled wrapper at `program` keeps, or
/// `None` when it's no compiled wrapper.
pub fn compiled_wrapper_command(program: &Path) -> Option<String> {
    let meta = fs::metadata(program).ok()?;
    if !meta.is_file() || meta.len() > COMPILED_WRAPPER_MAX {
        return None;
    }
    let bytes = fs::read(program).ok()?;
    if !bytes.starts_with(b"\x7fELF") {
        return None;
    }
    const START: &[u8] = b"\nmakeCWrapper ";
    let at = bytes
        .windows(START.len())
        .position(|window| window == START)?
        + 1;
    let rest = &bytes[at..];
    let end = [&b"\n\n\n#"[..], b"\0"]
        .iter()
        .filter_map(|stop| rest.windows(stop.len()).position(|window| window == *stop))
        .min()
        .unwrap_or(rest.len());
    Some(String::from_utf8_lossy(&rest[..end]).into_owned())
}

/// How the app's own command would have started it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// The arguments the program would have had, less the path to the app
    /// a generic Electron is given: the app's `process.argv`.
    pub args: Vec<String>,
    /// The environment it would have run in.
    pub env: Vec<(String, String)>,
}

/// Why the wrappers' launch isn't known.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WrapperError {
    #[error("{program} is no bash script or compiled wrapper, so there is no wrapper to follow")]
    NotBash { program: String },
    #[error("cannot follow {program}: {why}")]
    Unrunnable { program: String, why: String },
    #[error(
        "{program} never started a program within {seconds}s, so what its \
         wrappers set is unknown"
    )]
    NoLaunch { program: String, seconds: u64 },
    #[error(
        "{program} ends in {ran}, which runs no app from {resources}, so what \
         its wrappers set is unknown"
    )]
    NotTheApp {
        program: String,
        ran: String,
        resources: String,
    },
}

/// Records `args`, a program's command line, and this process's
/// environment, which the wrappers gave it, where [`through_wrappers`] reads
/// them: what `domicile` does when given [`RECORD`] first.
pub fn record(args: &[OsString]) -> Result<(), String> {
    let out = std::env::var_os("DOMICILE_ELECTRON_LAUNCH")
        .map(PathBuf::from)
        .ok_or("only an Electron app's wrappers record their launch")?;
    if let Some(command) = args
        .first()
        .and_then(|program| compiled_wrapper_command(Path::new(program)))
    {
        return follow_compiled(&out, &command, &args[1..]);
    }
    let mut written = Vec::new();
    for arg in args {
        written.extend_from_slice(arg.as_bytes());
        written.push(0);
    }
    let mut env = Vec::new();
    for (key, value) in std::env::vars_os() {
        env.extend_from_slice(key.as_bytes());
        env.push(b'=');
        env.extend_from_slice(value.as_bytes());
        env.push(0);
    }
    let write = |name: &str, bytes: &[u8]| {
        fs::write(out.join(name), bytes)
            .map_err(|why| format!("cannot record the launch in {}: {why}", out.display()))
    };
    write("args", &written)?;
    write("env", &env)?;
    write("done", b"")
}

/// Runs a compiled wrapper's `makeCWrapper` `command` as bash, given `args`,
/// in this process: see [`MAKE_C_WRAPPER`].
fn follow_compiled(out: &Path, command: &str, args: &[OsString]) -> Result<(), String> {
    let script = tempfile::Builder::new()
        .prefix("compiled-")
        .suffix(".bash")
        .tempfile_in(out)
        .and_then(|file| file.keep().map_err(|kept| kept.error))
        .map_err(|why| {
            format!(
                "cannot write a compiled wrapper's script in {}: {why}",
                out.display()
            )
        })?
        .1;
    fs::write(&script, format!("{MAKE_C_WRAPPER}{command}\n"))
        .map_err(|why| format!("cannot write {}: {why}", script.display()))?;
    let bash = std::env::var_os("DOMICILE_ELECTRON_BASH")
        .filter(|bash| !bash.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("PATH")
                .into_iter()
                .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
                .map(|dir| dir.join("bash"))
                .find(|candidate| candidate.is_file())
        })
        .ok_or("following a compiled wrapper needs bash, and there's none on PATH")?;
    let why = Command::new(&bash).arg(&script).args(args).exec();
    Err(format!("cannot run {}: {why}", bash.display()))
}

/// Runs `command`, the app's own, as far as the program its wrappers end in,
/// and gives what that program would have run with. `resources` is the
/// app's, as `electron_app` found it; the program must run the app there.
/// `recorder` is a `domicile` that [`record`]s. Gives up after `wait`.
pub fn through_wrappers(
    command: &[String],
    resources: &Path,
    recorder: &Path,
    wait: Duration,
) -> Result<Launch, WrapperError> {
    let program = command.first().cloned().unwrap_or_default();
    let compiled = compiled_wrapper_command(Path::new(&program)).is_some();
    if !compiled && !is_bash_script(Path::new(&program)) {
        return Err(WrapperError::NotBash { program });
    }
    let unrunnable = |why: std::io::Error| WrapperError::Unrunnable {
        program: program.clone(),
        why: why.to_string(),
    };
    let out = tempfile::tempdir().map_err(unrunnable)?;
    let follow = out.path().join("follow.bash");
    fs::write(&follow, FOLLOW).map_err(unrunnable)?;
    // A compiled wrapper starts as the recorder, which follows it.
    let mut follow_wrappers = if compiled {
        let mut recorder = Command::new(recorder);
        recorder.arg(RECORD).arg(&program);
        recorder
    } else {
        Command::new(&program)
    };
    follow_wrappers
        .args(&command[1..])
        .env("BASH_ENV", &follow)
        .env("DOMICILE_ELECTRON_LAUNCH", out.path())
        .env("DOMICILE_ELECTRON_RECORDER", recorder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // Its own group, so nothing it starts outlives a give-up.
        .process_group(0);
    let mut child = spawn_when_not_busy(&mut follow_wrappers).map_err(unrunnable)?;
    let started = Instant::now();
    let done = out.path().join("done");
    while !done.exists() {
        if matches!(child.try_wait(), Ok(Some(_))) && !done.exists() {
            break;
        }
        if started.elapsed() > wait {
            // SAFETY: a plain signal to the group spawned above.
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.wait();
    if !done.exists() {
        let mut said = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut said);
        }
        if !said.trim().is_empty() {
            eprintln!("domicile: {program} said: {}", said.trim());
        }
        return Err(WrapperError::NoLaunch {
            program,
            seconds: wait.as_secs(),
        });
    }
    let read = |name: &str| -> Result<Vec<String>, WrapperError> {
        let bytes = fs::read(out.path().join(name)).map_err(unrunnable)?;
        Ok(bytes
            .split(|byte| *byte == 0)
            .filter(|part| !part.is_empty())
            .map(|part| String::from_utf8_lossy(part).into_owned())
            .collect())
    };
    let mut args = read("args")?;
    let ran = args.remove(0);
    let canonical = |path: &Path| fs::canonicalize(path).ok();
    let resources = canonical(resources).unwrap_or_else(|| resources.to_path_buf());
    let inside = |word: &str| {
        word.starts_with('/')
            && canonical(Path::new(word)).is_some_and(|path| path.starts_with(&resources))
    };
    // A bundled app's binary sits beside its `resources/`; a generic
    // Electron is given the app's path as an argument.
    let beside = canonical(Path::new(&ran))
        .and_then(|path| path.parent().map(|dir| dir.join("resources")))
        .and_then(|dir| canonical(&dir))
        .is_some_and(|dir| dir == resources);
    if !beside {
        match args.iter().position(|word| inside(word)) {
            Some(app) => {
                args.remove(app);
            }
            None => {
                return Err(WrapperError::NotTheApp {
                    program,
                    ran,
                    resources: resources.display().to_string(),
                })
            }
        }
    }
    let env = read("env")?
        .into_iter()
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((key.to_string(), value.to_string()))
        })
        .filter(|(key, _)| !OURS.contains(&key.as_str()))
        .collect();
    Ok(Launch { args, env })
}

/// How long [`spawn_when_not_busy`] keeps trying.
const BUSY_WAIT: Duration = Duration::from_secs(2);

/// Spawns `command`, waiting out `ETXTBSY`. A script just written is busy
/// while any process forked before its writer closed it still holds the
/// writer's descriptor, until that process execs: another thread's spawn
/// can make it so for a moment, and an installer's write the same.
fn spawn_when_not_busy(command: &mut Command) -> std::io::Result<std::process::Child> {
    let started = Instant::now();
    loop {
        match command.spawn() {
            Err(why)
                if why.kind() == std::io::ErrorKind::ExecutableFileBusy
                    && started.elapsed() < BUSY_WAIT =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            spawned => return spawned,
        }
    }
}

/// Whether `program`, on `PATH` or not, starts with a `#!` naming bash.
fn is_bash_script(program: &Path) -> bool {
    let path: PathBuf = if program.components().count() > 1 {
        program.to_path_buf()
    } else {
        match std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .map(|dir| dir.join(program))
            .find(|candidate| candidate.is_file())
        {
            Some(found) => found,
            None => return false,
        }
    };
    let mut start = [0u8; 256];
    let read = fs::File::open(path)
        .and_then(|mut file| file.read(&mut start))
        .unwrap_or(0);
    let line = &start[..read];
    let line = line.split(|byte| *byte == b'\n').next().unwrap_or_default();
    line.starts_with(b"#!") && String::from_utf8_lossy(line).contains("bash")
}
