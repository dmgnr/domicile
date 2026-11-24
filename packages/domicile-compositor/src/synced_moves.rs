//! Popup moves held to the end of their commit transaction, so each names
//! the synced frames it shows with. See
//! `docs/architecture/WINDOW-COMPOSITING.md#synced-frames`.

use domicile_protocol::{AppFrame, HostMessage};

/// The moves and synced frames of the commit transaction being applied.
#[derive(Default)]
pub struct SyncedMoves {
    held: Vec<HostMessage>,
    frames: Vec<AppFrame>,
}

impl SyncedMoves {
    /// Hold `moved`, a `PopupPlaced`, until [`SyncedMoves::release`].
    pub fn hold(&mut self, moved: HostMessage) {
        self.held.push(moved);
    }

    /// Whether a submit now goes with a move, so it must be synced.
    pub fn awaited(&self) -> bool {
        !self.held.is_empty()
    }

    /// `app_id`'s submit went up at synced `frame`. A transaction applies
    /// each surface once.
    pub fn synced(&mut self, app_id: &str, frame: u32) {
        self.frames.push(AppFrame {
            app_id: app_id.to_string(),
            frame,
        });
    }

    /// The transaction's last commit is done. Returns the held moves, each
    /// naming every frame synced in it, and starts the next transaction.
    pub fn release(&mut self) -> Vec<HostMessage> {
        let synced = std::mem::take(&mut self.frames);
        std::mem::take(&mut self.held)
            .into_iter()
            .map(|mut moved| {
                if let HostMessage::PopupPlaced { frames, .. } = &mut moved {
                    // A frame synced now is newer than the one the host named.
                    frames.retain(|told| !synced.iter().any(|now| now.app_id == told.app_id));
                    frames.extend(synced.iter().cloned());
                }
                moved
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moved(app_id: &str, frames: Vec<AppFrame>) -> HostMessage {
        HostMessage::PopupPlaced {
            app_id: app_id.to_string(),
            parent: "app-1".to_string(),
            position: [12.0, 48.0],
            size: [180.0, 240.0],
            grab: false,
            frames,
        }
    }

    fn at(app_id: &str, frame: u32) -> AppFrame {
        AppFrame {
            app_id: app_id.to_string(),
            frame,
        }
    }

    #[test]
    fn a_move_names_each_frame_synced_with_it() {
        let mut moves = SyncedMoves::default();
        assert!(!moves.awaited());

        moves.hold(moved("app-2", vec![]));
        assert!(moves.awaited());
        // The popup's own content, then the parent's.
        moves.synced("app-2", 1);
        moves.synced("app-1", 4);

        assert_eq!(
            moves.release(),
            vec![moved("app-2", vec![at("app-2", 1), at("app-1", 4)])]
        );
        // The next transaction starts empty.
        assert!(!moves.awaited());
        assert_eq!(moves.release(), vec![]);
    }

    #[test]
    fn a_frame_synced_now_replaces_the_one_the_host_named() {
        let mut moves = SyncedMoves::default();
        moves.hold(moved("app-2", vec![at("app-2", 1)]));
        moves.synced("app-1", 3);
        moves.synced("app-2", 2);

        assert_eq!(
            moves.release(),
            vec![moved("app-2", vec![at("app-1", 3), at("app-2", 2)])]
        );
    }
}
