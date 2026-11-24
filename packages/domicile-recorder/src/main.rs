//! `domicile-recorder --video <node> [--sound <node>] <file.webm>`: records a
//! screen cast until stdin says `stop` or closes. See the crate's docs.

use std::io::BufRead;
use std::process::ExitCode;
use std::sync::mpsc;
use std::time::Duration;

use domicile_recorder::args::parse;
use domicile_recorder::command::{started, Command};
use domicile_recorder::pipeline::description;
use domicile_recorder::recording::{encoder, Recording};

/// How often the pipeline is checked for errors between commands.
const POLL: Duration = Duration::from_millis(100);

fn main() -> ExitCode {
    let args = match parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(usage) => {
            eprintln!("domicile-recorder: {usage}");
            return ExitCode::from(2);
        }
    };
    let encoder = match encoder() {
        Ok(encoder) => encoder,
        Err(why) => {
            eprintln!("domicile-recorder: the recording did not start: {why}");
            return ExitCode::FAILURE;
        }
    };
    let recording = match Recording::start(&description(&args.sources, encoder, &args.file)) {
        Ok(recording) => recording,
        Err(why) => {
            eprintln!("domicile-recorder: the recording did not start: {why}");
            return ExitCode::FAILURE;
        }
    };
    println!("{}", started(&encoder));
    let commands = commands();
    loop {
        if let Some(why) = recording.failure() {
            eprintln!("domicile-recorder: the recording failed: {why}");
            return ExitCode::FAILURE;
        }
        let done = match commands.recv_timeout(POLL) {
            Ok(Command::Pause) => recording.pause().map(|()| false),
            Ok(Command::Resume) => recording.resume().map(|()| false),
            // A closed stdin means the compositor is gone: keep what was
            // recorded.
            Ok(Command::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(false),
        };
        if let Err(why) = done {
            eprintln!("domicile-recorder: the recording failed: {why}");
            return ExitCode::FAILURE;
        }
    }
    match recording.stop() {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => {
            eprintln!("domicile-recorder: the file was not finished: {why}");
            ExitCode::FAILURE
        }
    }
}

/// Stdin's commands, read on a thread of their own. A line that is no
/// command is reported and skipped.
fn commands() -> mpsc::Receiver<Command> {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            match line.parse() {
                Ok(command) => {
                    if send.send(command).is_err() {
                        break;
                    }
                }
                Err(why) => eprintln!("domicile-recorder: {why}"),
            }
        }
    });
    receive
}
