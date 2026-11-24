//! What the compositor tells a running recorder, one line each on its stdin.

use crate::pipeline::Encoder;

/// The line the recorder says on stdout once its pipeline plays, naming the
/// encoder it chose. The compositor waits for it before it says the
/// recording runs, and logs the encoder.
pub fn started(encoder: &Encoder) -> String {
    format!("recording with {encoder:?}")
}

/// One line of the recorder's stdin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// Stop taking frames and sound. The file skips the time paused.
    Pause,
    /// Take frames and sound again after a pause.
    Resume,
    /// Finish the file and exit.
    Stop,
}

/// A line that names no [`Command`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0:?} is not a recorder command: pause, resume or stop")]
pub struct Unknown(pub String);

impl std::str::FromStr for Command {
    type Err = Unknown;

    fn from_str(line: &str) -> Result<Self, Self::Err> {
        match line.trim() {
            "pause" => Ok(Command::Pause),
            "resume" => Ok(Command::Resume),
            "stop" => Ok(Command::Stop),
            other => Err(Unknown(other.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::GpuEncoder;

    #[test]
    fn the_started_line_names_the_encoder() {
        assert_eq!(
            started(&Encoder::Gpu(GpuEncoder::Av1)),
            "recording with Gpu(Av1)"
        );
        assert_eq!(started(&Encoder::Cpu), "recording with Cpu");
    }

    #[test]
    fn each_command_is_its_own_word_on_a_line() {
        assert_eq!("pause\n".parse(), Ok(Command::Pause));
        assert_eq!("resume".parse(), Ok(Command::Resume));
        assert_eq!("stop".parse(), Ok(Command::Stop));
        assert_eq!(
            "rewind".parse::<Command>(),
            Err(Unknown("rewind".to_string()))
        );
    }
}
