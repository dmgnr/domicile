//! Which buffers the engine has imported, which it is still importing, and the
//! frame each surface holds back for an import.
//!
//! An engine import belongs to one surface, so a buffer committed to two
//! surfaces is imported for each.
//!
//! An import is a round trip through the browser to the GPU process, so the
//! compositor does not wait for one. A frame whose buffer is new waits here
//! and goes up when the import finishes. A newer frame replaces it, as in
//! `engine_waiting`.

use std::collections::HashMap;
use std::hash::Hash;

use crate::engine::{BufferId, Request, SurfaceId};

/// The imports, by surface and buffer `K`, and the frames `F` waiting on them.
#[derive(Debug)]
pub struct Imports<K, F> {
    done: HashMap<(SurfaceId, K), BufferId>,
    importing: HashMap<Request, Importing<K>>,
    waiting: HashMap<SurfaceId, (K, F)>,
    last_request: Request,
}

/// An import the engine has not answered.
#[derive(Debug)]
struct Importing<K> {
    surface: SurfaceId,
    /// `None` once the buffer is gone, so the answer is forgotten.
    key: Option<K>,
}

/// Where a frame goes. See [`Imports::route`].
#[derive(Debug, PartialEq)]
pub enum Route<F> {
    /// Its buffer is imported as `id`, so submit it. Release `replaced`, an
    /// older frame that was waiting.
    Submit {
        id: BufferId,
        frame: F,
        replaced: Option<F>,
    },
    /// It waits for its buffer's import. Release `replaced`. Ask the engine to
    /// import the buffer as `start`, if set.
    Wait {
        replaced: Option<F>,
        start: Option<Request>,
    },
}

/// What a finished import lets through. See [`Imports::finished`].
#[derive(Debug, PartialEq)]
pub struct Finished<F> {
    /// An id imported for a buffer or surface that went meanwhile. Tell the
    /// engine to forget it.
    pub forget: Option<(SurfaceId, BufferId)>,
    /// The frame that waited on it.
    pub then: Option<Then<F>>,
}

/// A frame whose import finished.
#[derive(Debug, PartialEq)]
pub enum Then<F> {
    /// Submit it, showing `id`.
    Submit {
        surface: SurfaceId,
        id: BufferId,
        frame: F,
    },
    /// The engine refused its buffer. Release it.
    Refused { surface: SurfaceId, frame: F },
}

/// What [`Imports::forget`] took out.
#[derive(Debug, PartialEq)]
pub struct Forgotten<F> {
    /// The buffer's imports, for the engine to forget.
    pub ids: Vec<(SurfaceId, BufferId)>,
    /// Frames that waited on it, to release.
    pub waited: Vec<(SurfaceId, F)>,
}

/// What [`Imports::surface_gone`] took out.
#[derive(Debug, PartialEq)]
pub struct Gone<F> {
    /// The surface's imports, for the engine to forget.
    pub ids: Vec<BufferId>,
    /// The frame that waited on the surface, to release.
    pub waited: Option<F>,
}

impl<K, F> Default for Imports<K, F> {
    fn default() -> Self {
        Imports {
            done: HashMap::new(),
            importing: HashMap::new(),
            waiting: HashMap::new(),
            last_request: 0,
        }
    }
}

impl<K: Clone + Eq + Hash, F> Imports<K, F> {
    /// Whether `key` is imported for `surface`.
    pub fn knows(&self, surface: SurfaceId, key: &K) -> bool {
        self.done.contains_key(&(surface, key.clone()))
    }

    /// Records an import that finished while the caller waited.
    pub fn imported(&mut self, surface: SurfaceId, key: K, id: BufferId) {
        self.done.insert((surface, key), id);
    }

    /// Decides whether `frame`, showing buffer `key`, goes up now or waits for
    /// an import.
    pub fn route(&mut self, surface: SurfaceId, key: K, frame: F) -> Route<F> {
        match self.done.get(&(surface, key.clone())) {
            Some(id) => Route::Submit {
                id: *id,
                frame,
                replaced: self.waiting.remove(&surface).map(|(_, frame)| frame),
            },
            None => {
                let start =
                    (!self.is_importing(surface, &key)).then(|| self.start(surface, key.clone()));
                Route::Wait {
                    replaced: self
                        .waiting
                        .insert(surface, (key, frame))
                        .map(|(_, frame)| frame),
                    start,
                }
            }
        }
    }

    /// The frame waiting for an import on `surface`, to change in place.
    pub fn waiting_mut(&mut self, surface: SurfaceId) -> Option<&mut F> {
        self.waiting.get_mut(&surface).map(|(_, frame)| frame)
    }

    /// Records the engine's answer to `request`: the buffer's id, or `None` if
    /// it refused the buffer.
    pub fn finished(&mut self, request: Request, buffer: Option<BufferId>) -> Finished<F> {
        let importing = self
            .importing
            .remove(&request)
            .expect("the engine answers only the imports it was asked for");
        let Some(key) = importing.key else {
            return Finished {
                forget: buffer.map(|id| (importing.surface, id)),
                then: None,
            };
        };
        let surface = importing.surface;
        if let Some(id) = buffer {
            self.done.insert((surface, key.clone()), id);
        }
        let waits = self
            .waiting
            .get(&surface)
            .is_some_and(|(waits_on, _)| *waits_on == key);
        let then = waits.then(|| {
            let (_, frame) = self.waiting.remove(&surface).expect("just found");
            match buffer {
                Some(id) => Then::Submit { surface, id, frame },
                None => Then::Refused { surface, frame },
            }
        });
        Finished { forget: None, then }
    }

    /// Drops the imports of every key `of` matches on every surface, for a
    /// destroyed `wl_buffer` or a freed upload: a buffer is under one key per
    /// color it was imported in. An import still running is forgotten when it
    /// finishes.
    pub fn forget(&mut self, of: impl Fn(&K) -> bool) -> Forgotten<F> {
        for importing in self.importing.values_mut() {
            if importing.key.as_ref().is_some_and(&of) {
                importing.key = None;
            }
        }
        Forgotten {
            ids: self
                .done
                .extract_if(|(_, key), _| of(key))
                .map(|((surface, _), id)| (surface, id))
                .collect(),
            waited: self
                .waiting
                .extract_if(|_, (waits_on, _)| of(waits_on))
                .map(|(surface, (_, frame))| (surface, frame))
                .collect(),
        }
    }

    /// Drops everything of `surface`'s, for a window that went.
    pub fn surface_gone(&mut self, surface: SurfaceId) -> Gone<F> {
        for importing in self.importing.values_mut() {
            if importing.surface == surface {
                importing.key = None;
            }
        }
        Gone {
            ids: self
                .done
                .extract_if(|(of, _), _| *of == surface)
                .map(|(_, id)| id)
                .collect(),
            waited: self.waiting.remove(&surface).map(|(_, frame)| frame),
        }
    }

    /// Drops every import, for a lost engine, and returns the frames that
    /// waited.
    pub fn clear(&mut self) -> Vec<(SurfaceId, F)> {
        self.done.clear();
        self.importing.clear();
        self.waiting
            .drain()
            .map(|(surface, (_, frame))| (surface, frame))
            .collect()
    }

    fn is_importing(&self, surface: SurfaceId, key: &K) -> bool {
        self.importing
            .values()
            .any(|importing| importing.surface == surface && importing.key.as_ref() == Some(key))
    }

    fn start(&mut self, surface: SurfaceId, key: K) -> Request {
        self.last_request += 1;
        self.importing.insert(
            self.last_request,
            Importing {
                surface,
                key: Some(key),
            },
        );
        self.last_request
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SURFACE: SurfaceId = 1;
    const OTHER: SurfaceId = 2;

    /// Buffers and frames are stand-ins: a buffer is a letter, a frame a
    /// number.
    type Under = Imports<char, u32>;

    /// Routes a frame that must wait, and returns the import it started.
    fn waits(imports: &mut Under, surface: SurfaceId, key: char, frame: u32) -> Option<Request> {
        match imports.route(surface, key, frame) {
            Route::Wait { start, .. } => start,
            Route::Submit { .. } => panic!("frame {frame} went up without its import"),
        }
    }

    #[test]
    fn a_frame_waiting_for_its_import_can_be_changed_in_place() {
        let mut imports = Under::default();
        let request = waits(&mut imports, SURFACE, 'a', 1);

        *imports.waiting_mut(SURFACE).expect("it waits") = 2;

        assert_eq!(imports.waiting_mut(OTHER), None, "another surface has none");
        assert_eq!(
            imports
                .finished(request.expect("an import started"), Some(10))
                .then,
            Some(Then::Submit {
                surface: SURFACE,
                id: 10,
                frame: 2
            }),
            "the changed frame goes up, on the import it waited for"
        );
    }

    #[test]
    fn a_new_buffer_waits_for_its_import_and_then_goes_up_at_once() {
        let mut imports = Under::default();

        assert_eq!(
            imports.route(SURFACE, 'a', 1),
            Route::Wait {
                replaced: None,
                start: Some(1)
            }
        );
        assert_eq!(
            imports.finished(1, Some(10)),
            Finished {
                forget: None,
                then: Some(Then::Submit {
                    surface: SURFACE,
                    id: 10,
                    frame: 1
                })
            }
        );
        assert_eq!(
            imports.route(SURFACE, 'a', 2),
            Route::Submit {
                id: 10,
                frame: 2,
                replaced: None
            }
        );
    }

    #[test]
    fn a_buffer_being_imported_is_not_imported_twice_and_its_newest_frame_goes_up() {
        let mut imports = Under::default();
        let request = waits(&mut imports, SURFACE, 'a', 1).expect("an import starts");

        assert_eq!(
            imports.route(SURFACE, 'a', 2),
            Route::Wait {
                replaced: Some(1),
                start: None
            }
        );
        assert_eq!(
            imports.finished(request, Some(10)).then,
            Some(Then::Submit {
                surface: SURFACE,
                id: 10,
                frame: 2
            })
        );
    }

    #[test]
    fn a_buffer_on_two_surfaces_is_imported_for_each() {
        let mut imports = Under::default();
        let first = waits(&mut imports, SURFACE, 'a', 1).expect("an import starts");
        let second = waits(&mut imports, OTHER, 'a', 2).expect("and another for the other surface");

        assert_eq!(
            imports.finished(first, Some(10)).then,
            Some(Then::Submit {
                surface: SURFACE,
                id: 10,
                frame: 1
            })
        );
        assert_eq!(
            imports.finished(second, Some(20)).then,
            Some(Then::Submit {
                surface: OTHER,
                id: 20,
                frame: 2
            })
        );
        assert_eq!(
            (imports.route(SURFACE, 'a', 3), imports.route(OTHER, 'a', 4)),
            (
                Route::Submit {
                    id: 10,
                    frame: 3,
                    replaced: None
                },
                Route::Submit {
                    id: 20,
                    frame: 4,
                    replaced: None
                }
            )
        );
    }

    #[test]
    fn an_imported_buffer_goes_up_past_a_frame_still_waiting() {
        let mut imports = Under::default();
        imports.imported(SURFACE, 'a', 10);
        let request = waits(&mut imports, SURFACE, 'b', 1).expect("an import starts");

        assert_eq!(
            imports.route(SURFACE, 'a', 2),
            Route::Submit {
                id: 10,
                frame: 2,
                replaced: Some(1)
            }
        );
        assert_eq!(imports.finished(request, Some(11)).then, None);
        assert!(
            imports.knows(SURFACE, &'b'),
            "and the import is kept for next time"
        );
    }

    #[test]
    fn a_refused_buffer_hands_its_frame_back_and_is_tried_again_next_time() {
        let mut imports = Under::default();
        let request = waits(&mut imports, SURFACE, 'a', 1).expect("an import starts");

        assert_eq!(
            imports.finished(request, None).then,
            Some(Then::Refused {
                surface: SURFACE,
                frame: 1
            })
        );
        assert!(!imports.knows(SURFACE, &'a'));
        assert_eq!(waits(&mut imports, SURFACE, 'a', 2), Some(request + 1));
    }

    #[test]
    fn a_forgotten_buffer_s_imports_are_dropped_on_every_surface_even_while_they_run() {
        let mut imports = Under::default();
        imports.imported(SURFACE, 'a', 10);
        imports.imported(OTHER, 'a', 12);
        let request = waits(&mut imports, OTHER, 'b', 1).expect("an import starts");

        let mut forgotten = imports.forget(|key| *key == 'a');

        forgotten.ids.sort();
        assert_eq!(
            forgotten,
            Forgotten {
                ids: vec![(SURFACE, 10), (OTHER, 12)],
                waited: vec![]
            }
        );
        assert_eq!(
            imports.forget(|key| *key == 'b'),
            Forgotten {
                ids: vec![],
                waited: vec![(OTHER, 1)]
            }
        );
        assert_eq!(
            imports.finished(request, Some(11)),
            Finished {
                forget: Some((OTHER, 11)),
                then: None
            }
        );
        assert!(!imports.knows(OTHER, &'a') && !imports.knows(OTHER, &'b'));
    }

    #[test]
    fn a_buffer_in_a_new_color_is_imported_again_and_forgotten_in_every_color() {
        // As the session keys them: a buffer, and the color it was imported in.
        let mut imports = Imports::<(char, u64), u32>::default();
        let old = match imports.route(SURFACE, ('a', 0), 1) {
            Route::Wait { start, .. } => start.expect("an import starts"),
            Route::Submit { .. } => panic!("nothing is imported yet"),
        };
        let new = match imports.route(SURFACE, ('a', 1), 2) {
            Route::Wait { start, replaced } => {
                assert_eq!(replaced, Some(1));
                start.expect("the new color is imported too")
            }
            Route::Submit { .. } => panic!("the new color is not imported yet"),
        };

        assert_eq!(
            imports.finished(old, Some(10)).then,
            None,
            "the old color's import does not show the frame drawn in the new"
        );
        assert_eq!(
            imports.finished(new, Some(11)).then,
            Some(Then::Submit {
                surface: SURFACE,
                id: 11,
                frame: 2
            })
        );
        let mut forgotten = imports.forget(|(buffer, _)| *buffer == 'a');
        forgotten.ids.sort();
        assert_eq!(forgotten.ids, vec![(SURFACE, 10), (SURFACE, 11)]);
    }

    #[test]
    fn a_gone_surface_takes_its_imports_and_frame_and_no_other_s() {
        let mut imports = Under::default();
        imports.imported(SURFACE, 'a', 10);
        imports.imported(SURFACE, 'b', 11);
        imports.imported(OTHER, 'a', 12);
        let request = waits(&mut imports, SURFACE, 'd', 1).expect("an import starts");

        let mut gone = imports.surface_gone(SURFACE);

        gone.ids.sort();
        assert_eq!(
            gone,
            Gone {
                ids: vec![10, 11],
                waited: Some(1)
            }
        );
        assert!(imports.knows(OTHER, &'a'));
        assert_eq!(
            imports.finished(request, Some(13)).forget,
            Some((SURFACE, 13))
        );
    }

    #[test]
    fn a_lost_engine_takes_every_import_and_hands_back_every_frame() {
        let mut imports = Under::default();
        imports.imported(SURFACE, 'a', 10);
        waits(&mut imports, OTHER, 'b', 1);

        assert_eq!(imports.clear(), vec![(OTHER, 1)]);
        assert!(!imports.knows(SURFACE, &'a'));
        assert_eq!(
            waits(&mut imports, OTHER, 'b', 2),
            Some(2),
            "and the next import starts afresh, under a new number"
        );
    }
}
