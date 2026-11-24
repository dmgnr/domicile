//! `wp_color_management_v1`: a client says how its pixels encode color, and
//! learns how each display and its own surface would like them. The engine
//! draws a described surface's buffers in its color (see
//! [`crate::engine_session::EngineSession::describe`]); viz converts them to
//! each display's. See `docs/architecture/COLOR.md`.
//!
//! Version 1, parametric descriptions only. A display driven in HDR describes
//! itself as HDR10 ([`Description::of_display`]), every other as sRGB with
//! gamma 2.2. A surface prefers the description of the display holding most of
//! it, and hears when that changes.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use smithay::output::Output;
use smithay::reexports::wayland_protocols::wp::color_management::v1::server::{
    wp_color_management_output_v1::{self, WpColorManagementOutputV1},
    wp_color_management_surface_feedback_v1::{self, WpColorManagementSurfaceFeedbackV1},
    wp_color_management_surface_v1::{self, WpColorManagementSurfaceV1},
    wp_color_manager_v1::{
        self, Feature, Primaries, RenderIntent, TransferFunction, WpColorManagerV1,
    },
    wp_image_description_creator_icc_v1::{self, WpImageDescriptionCreatorIccV1},
    wp_image_description_creator_params_v1::{self, WpImageDescriptionCreatorParamsV1},
    wp_image_description_info_v1::WpImageDescriptionInfoV1,
    wp_image_description_v1::{self, WpImageDescriptionV1},
};
use smithay::reexports::wayland_server::protocol::{wl_output::WlOutput, wl_surface::WlSurface};
use smithay::reexports::wayland_server::{
    backend::ClientId, Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource,
    WEnum,
};
use smithay::wayland::compositor::{with_states, Cacheable};

use crate::engine::{Chromaticity, Color, Hdr, HdrState};
use crate::screens::Screens;
use crate::DomicileCompositor;

/// The version advertised. Version 2 renames `ready` and `preferred_changed`
/// for 64-bit identities and adds nothing a client needs.
const VERSION: u32 = 1;

/// Advertises the manager.
pub fn advertise(display: &DisplayHandle) {
    display.create_global::<DomicileCompositor, WpColorManagerV1, _>(VERSION, ());
}

/// The named primaries a description can have. `wp_color_manager_v1` names
/// more; these are the ones viz has.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Named {
    Srgb,
    Bt2020,
    DisplayP3,
    AdobeRgb,
}

impl Named {
    const ALL: [Named; 4] = [
        Named::Srgb,
        Named::Bt2020,
        Named::DisplayP3,
        Named::AdobeRgb,
    ];

    fn from_protocol(primaries: Primaries) -> Option<Self> {
        match primaries {
            Primaries::Srgb => Some(Named::Srgb),
            Primaries::Bt2020 => Some(Named::Bt2020),
            Primaries::DisplayP3 => Some(Named::DisplayP3),
            Primaries::AdobeRgb => Some(Named::AdobeRgb),
            _ => None,
        }
    }

    fn protocol(self) -> Primaries {
        match self {
            Named::Srgb => Primaries::Srgb,
            Named::Bt2020 => Primaries::Bt2020,
            Named::DisplayP3 => Primaries::DisplayP3,
            Named::AdobeRgb => Primaries::AdobeRgb,
        }
    }

    /// Red, green, blue and white, as the protocol defines each.
    fn chromaticities(self) -> [Chromaticity; 4] {
        let xy = |x, y| Chromaticity { x, y };
        let d65 = xy(0.3127, 0.3290);
        match self {
            Named::Srgb => [xy(0.64, 0.33), xy(0.30, 0.60), xy(0.15, 0.06), d65],
            Named::Bt2020 => [xy(0.708, 0.292), xy(0.170, 0.797), xy(0.131, 0.046), d65],
            Named::DisplayP3 => [xy(0.680, 0.320), xy(0.265, 0.690), xy(0.150, 0.060), d65],
            Named::AdobeRgb => [xy(0.64, 0.33), xy(0.21, 0.71), xy(0.15, 0.06), d65],
        }
    }

    /// `DOMICILE_PRIMARIES_*`.
    fn engine(self) -> u32 {
        match self {
            Named::Srgb => 0,
            Named::Bt2020 => 1,
            Named::DisplayP3 => 2,
            Named::AdobeRgb => 3,
        }
    }
}

/// The transfer functions a description can have.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Transfer {
    /// The sRGB piecewise curve, which version 1 calls `srgb`.
    Srgb,
    Gamma22,
    Bt1886,
    ExtLinear,
    Pq,
    Hlg,
    /// `create_windows_scrgb`'s: extended linear, 1.0 at 80 cd/m². Not a name
    /// a client can set.
    WindowsScrgb,
}

impl Transfer {
    /// The ones a client can name.
    const NAMED: [Transfer; 6] = [
        Transfer::Srgb,
        Transfer::Gamma22,
        Transfer::Bt1886,
        Transfer::ExtLinear,
        Transfer::Pq,
        Transfer::Hlg,
    ];

    fn from_protocol(tf: TransferFunction) -> Option<Self> {
        match tf {
            TransferFunction::Srgb => Some(Transfer::Srgb),
            TransferFunction::Gamma22 => Some(Transfer::Gamma22),
            TransferFunction::Bt1886 => Some(Transfer::Bt1886),
            TransferFunction::ExtLinear => Some(Transfer::ExtLinear),
            TransferFunction::St2084Pq => Some(Transfer::Pq),
            TransferFunction::Hlg => Some(Transfer::Hlg),
            _ => None,
        }
    }

    fn protocol(self) -> TransferFunction {
        match self {
            Transfer::Srgb => TransferFunction::Srgb,
            Transfer::Gamma22 => TransferFunction::Gamma22,
            Transfer::Bt1886 => TransferFunction::Bt1886,
            Transfer::ExtLinear | Transfer::WindowsScrgb => TransferFunction::ExtLinear,
            Transfer::Pq => TransferFunction::St2084Pq,
            Transfer::Hlg => TransferFunction::Hlg,
        }
    }

    /// `DOMICILE_TRANSFER_*`.
    fn engine(self) -> u32 {
        match self {
            Transfer::Srgb => 0,
            Transfer::Gamma22 => 1,
            Transfer::Bt1886 => 2,
            Transfer::ExtLinear => 3,
            Transfer::Pq => 4,
            Transfer::Hlg => 5,
            Transfer::WindowsScrgb => 6,
        }
    }

    /// The luminances a description has when the client sets none, as
    /// `set_luminances` and BT.2408 give them.
    fn default_luminances(self) -> Luminances {
        match self {
            Transfer::Pq => Luminances {
                min: 0.005,
                max: 10_000.0,
                reference: 203.0,
            },
            Transfer::Hlg => Luminances {
                min: 0.005,
                max: 1_000.0,
                reference: 203.0,
            },
            _ => Luminances {
                min: 0.2,
                max: 80.0,
                reference: 80.0,
            },
        }
    }
}

/// A luminance range and reference white, in cd/m².
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Luminances {
    pub min: f64,
    pub max: f64,
    pub reference: f64,
}

/// An image description: how pixels encode color.
#[derive(Debug, Clone, PartialEq)]
pub struct Description {
    pub primaries: Named,
    pub transfer: Transfer,
    /// `None` for the transfer function's defaults.
    pub luminances: Option<Luminances>,
    /// The mastering display's red, green, blue and white.
    pub mastering_primaries: Option<[Chromaticity; 4]>,
    /// The mastering display's min and max luminance, in cd/m².
    pub mastering_luminance: Option<(f64, f64)>,
    pub max_cll: Option<u32>,
    pub max_fall: Option<u32>,
}

impl Description {
    /// What a display in SDR is: sRGB primaries, gamma 2.2.
    pub fn sdr_display() -> Self {
        Description::named(Named::Srgb, Transfer::Gamma22)
    }

    /// What a display is: HDR10 while it is driven in HDR, with SDR white
    /// where the engine draws it and the panel's luminance range as its
    /// target, and [`sdr_display`](Description::sdr_display) otherwise.
    pub fn of_display(hdr: &Hdr) -> Self {
        if hdr.state != HdrState::On {
            return Description::sdr_display();
        }
        let pq = Transfer::Pq.default_luminances();
        // The panel's black is in 0.0001 cd/m²; zero is unreported.
        let min = if hdr.min_luminance > 0 {
            f64::from(hdr.min_luminance) / 10_000.0
        } else {
            pq.min
        };
        Description {
            luminances: Some(Luminances {
                min,
                max: pq.max,
                reference: f64::from(hdr.sdr_white),
            }),
            mastering_luminance: (hdr.max_luminance > 0)
                .then(|| (min, f64::from(hdr.max_luminance))),
            ..Description::named(Named::Bt2020, Transfer::Pq)
        }
    }

    fn named(primaries: Named, transfer: Transfer) -> Self {
        Description {
            primaries,
            transfer,
            luminances: None,
            mastering_primaries: None,
            mastering_luminance: None,
            max_cll: None,
            max_fall: None,
        }
    }

    fn luminances(&self) -> Luminances {
        self.luminances
            .unwrap_or_else(|| self.transfer.default_luminances())
    }

    /// The target luminance range: the mastering display's, else the primary
    /// color volume's.
    fn target_luminance(&self) -> (f64, f64) {
        self.mastering_luminance.unwrap_or_else(|| {
            let luminances = self.luminances();
            let max = match self.transfer {
                Transfer::Pq => luminances.min + 10_000.0,
                _ => luminances.max,
            };
            (luminances.min, max)
        })
    }

    /// The description as the engine takes it.
    pub fn engine_color(&self) -> Color {
        let has_mastering =
            self.mastering_primaries.is_some() || self.mastering_luminance.is_some();
        let [red, green, blue, white] = self
            .mastering_primaries
            .unwrap_or_else(|| self.primaries.chromaticities());
        let (mastering_min, mastering_max) = self.target_luminance();
        Color {
            primaries: self.primaries.engine(),
            transfer: self.transfer.engine(),
            reference_luminance: self
                .luminances
                .map_or(0.0, |luminances| luminances.reference as f32),
            has_mastering: u32::from(has_mastering),
            mastering_red: red,
            mastering_green: green,
            mastering_blue: blue,
            mastering_white: white,
            mastering_min_luminance: if has_mastering {
                mastering_min as f32
            } else {
                0.0
            },
            mastering_max_luminance: if has_mastering {
                mastering_max as f32
            } else {
                0.0
            },
            max_cll: self.max_cll.unwrap_or(0) as f32,
            max_fall: self.max_fall.unwrap_or(0) as f32,
        }
    }
}

/// A `wp_image_description_v1`. Each is ready once made: every description
/// this accepts, the engine draws.
#[derive(Debug)]
pub struct ImageDescription {
    description: Description,
    /// Whether `get_information` is allowed: only for the compositor's own.
    information: bool,
}

/// The description `surface` last committed. `None` is sRGB, as the surface
/// had none.
pub fn committed_color(surface: &WlSurface) -> Option<Color> {
    with_states(surface, |states| {
        states
            .cached_state
            .get::<ColorCachedState>()
            .current()
            .description
            .as_ref()
            .map(|description| description.engine_color())
    })
}

/// A surface's description, double-buffered with `wl_surface.commit`.
#[derive(Debug, Default, Clone)]
pub struct ColorCachedState {
    description: Option<Arc<Description>>,
}

impl Cacheable for ColorCachedState {
    fn commit(&mut self, _: &DisplayHandle) -> Self {
        self.clone()
    }

    fn merge_into(self, into: &mut Self, _: &DisplayHandle) {
        *into = self;
    }
}

/// Marks a surface with a live `wp_color_management_surface_v1`.
#[derive(Default)]
struct ColorManaged(AtomicBool);

fn set_pending(surface: &WlSurface, description: Option<Arc<Description>>) {
    with_states(surface, |states| {
        states
            .cached_state
            .get::<ColorCachedState>()
            .pending()
            .description = description;
    });
}

/// Identities for `ready`: nonzero, and never reused.
static LAST_IDENTITY: AtomicU32 = AtomicU32::new(0);

/// A new identity for `ready` or `preferred_changed`.
fn new_identity() -> u32 {
    LAST_IDENTITY.fetch_add(1, Ordering::Relaxed) + 1
}

/// Makes `new` a ready image description of `description`.
fn ready(
    data_init: &mut DataInit<'_, DomicileCompositor>,
    new: New<WpImageDescriptionV1>,
    description: Description,
    information: bool,
) {
    ready_as(data_init, new, description, information, new_identity());
}

/// Makes `new` a ready image description of `description`, with `identity`.
fn ready_as(
    data_init: &mut DataInit<'_, DomicileCompositor>,
    new: New<WpImageDescriptionV1>,
    description: Description,
    information: bool,
    identity: u32,
) {
    let made = data_init.init(
        new,
        ImageDescription {
            description,
            information,
        },
    );
    made.ready(identity);
}

/// The `wp_color_management_output_v1`s clients hold, each with the
/// description it last stated, so each hears when its display goes into or
/// out of HDR.
#[derive(Debug, Default)]
pub struct DisplayColors {
    outputs: Vec<(WpColorManagementOutputV1, WlOutput, Description)>,
}

impl DisplayColors {
    /// Sends `image_description_changed` to each output whose display's
    /// description is no longer the one it stated, and forgets those clients
    /// let go of.
    pub fn restate(&mut self, screens: &Screens) {
        self.outputs.retain(|(color, _, _)| color.is_alive());
        for (color, output, stated) in &mut self.outputs {
            let now = description_of(screens, output);
            if now != *stated {
                *stated = now;
                color.image_description_changed();
            }
        }
    }
}

/// The description of the display `output` advertises. One that is gone is in
/// SDR.
fn description_of(screens: &Screens, output: &WlOutput) -> Description {
    let hdr = Output::from_resource(output)
        .map_or_else(Hdr::default, |output| screens.hdr_of(&output.name()));
    Description::of_display(&hdr)
}

/// A surface's preferred description, with its identity, and the feedback
/// objects to tell when it changes.
struct Preferred(Mutex<PreferredState>);

struct PreferredState {
    description: Description,
    identity: u32,
    feedbacks: Vec<WpColorManagementSurfaceFeedbackV1>,
}

impl Default for Preferred {
    fn default() -> Self {
        Preferred(Mutex::new(PreferredState {
            description: Description::sdr_display(),
            identity: new_identity(),
            feedbacks: Vec::new(),
        }))
    }
}

fn with_preferred<T>(surface: &WlSurface, f: impl FnOnce(&mut PreferredState) -> T) -> T {
    with_states(surface, |states| {
        states
            .data_map
            .insert_if_missing_threadsafe(Preferred::default);
        let preferred = states.data_map.get::<Preferred>().expect("inserted above");
        let mut state = preferred.0.lock().unwrap();
        f(&mut state)
    })
}

/// Makes `description` what `surface` prefers, and tells its feedback objects
/// if that changed.
pub fn prefer(surface: &WlSurface, description: Description) {
    with_preferred(surface, |state| {
        state.feedbacks.retain(Resource::is_alive);
        if state.description == description {
            return;
        }
        state.description = description;
        state.identity = new_identity();
        for feedback in &state.feedbacks {
            feedback.preferred_changed(state.identity);
        }
    });
}

/// Sends a chromaticity event's eight values, each times a million.
fn millionths(primaries: &[Chromaticity; 4]) -> [i32; 8] {
    let scale = |value: f32| (f64::from(value) * 1_000_000.0).round() as i32;
    let [r, g, b, w] = primaries;
    [
        scale(r.x),
        scale(r.y),
        scale(g.x),
        scale(g.y),
        scale(b.x),
        scale(b.y),
        scale(w.x),
        scale(w.y),
    ]
}

/// Sends `description` to `info`, then `done`.
fn inform(info: &WpImageDescriptionInfoV1, description: &Description) {
    let [rx, ry, gx, gy, bx, by, wx, wy] = millionths(&description.primaries.chromaticities());
    info.primaries(rx, ry, gx, gy, bx, by, wx, wy);
    info.primaries_named(description.primaries.protocol());
    info.tf_named(description.transfer.protocol());
    let luminances = description.luminances();
    info.luminances(
        (luminances.min * 10_000.0).round() as u32,
        luminances.max.round() as u32,
        luminances.reference.round() as u32,
    );
    let target = description
        .mastering_primaries
        .unwrap_or_else(|| description.primaries.chromaticities());
    let [rx, ry, gx, gy, bx, by, wx, wy] = millionths(&target);
    info.target_primaries(rx, ry, gx, gy, bx, by, wx, wy);
    let (min, max) = description.target_luminance();
    info.target_luminance((min * 10_000.0).round() as u32, max.round() as u32);
    if let Some(max_cll) = description.max_cll {
        info.target_max_cll(max_cll);
    }
    if let Some(max_fall) = description.max_fall {
        info.target_max_fall(max_fall);
    }
    info.done();
}

impl GlobalDispatch<WpColorManagerV1, ()> for DomicileCompositor {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<WpColorManagerV1>,
        _: &(),
        data_init: &mut DataInit<'_, Self>,
    ) {
        let manager = data_init.init(resource, ());
        manager.supported_intent(RenderIntent::Perceptual);
        for feature in [
            Feature::Parametric,
            Feature::SetLuminances,
            Feature::SetMasteringDisplayPrimaries,
            Feature::ExtendedTargetVolume,
            Feature::WindowsScrgb,
        ] {
            manager.supported_feature(feature);
        }
        for transfer in Transfer::NAMED {
            manager.supported_tf_named(transfer.protocol());
        }
        for primaries in Named::ALL {
            manager.supported_primaries_named(primaries.protocol());
        }
        manager.done();
    }
}

impl Dispatch<WpColorManagerV1, ()> for DomicileCompositor {
    fn request(
        state: &mut Self,
        _: &Client,
        manager: &WpColorManagerV1,
        request: wp_color_manager_v1::Request,
        _: &(),
        _: &DisplayHandle,
        data_init: &mut DataInit<'_, Self>,
    ) {
        match request {
            wp_color_manager_v1::Request::GetOutput { id, output } => {
                let color = data_init.init(id, output.clone());
                let stated = description_of(&state.screens, &output);
                state.display_colors.outputs.push((color, output, stated));
            }
            wp_color_manager_v1::Request::GetSurface { id, surface } => {
                let taken = with_states(&surface, |states| {
                    states
                        .data_map
                        .insert_if_missing_threadsafe(ColorManaged::default);
                    states
                        .data_map
                        .get::<ColorManaged>()
                        .expect("inserted above")
                        .0
                        .swap(true, Ordering::Relaxed)
                });
                if taken {
                    manager.post_error(
                        wp_color_manager_v1::Error::SurfaceExists,
                        "the surface already has a wp_color_management_surface_v1",
                    );
                    return;
                }
                data_init.init(id, surface);
            }
            wp_color_manager_v1::Request::GetSurfaceFeedback { id, surface } => {
                let feedback = data_init.init(id, surface.clone());
                with_preferred(&surface, |state| state.feedbacks.push(feedback));
            }
            wp_color_manager_v1::Request::CreateParametricCreator { obj } => {
                data_init.init(obj, Mutex::new(Params::default()));
            }
            wp_color_manager_v1::Request::CreateWindowsScrgb { image_description } => {
                ready(
                    data_init,
                    image_description,
                    Description::named(Named::Srgb, Transfer::WindowsScrgb),
                    false,
                );
            }
            wp_color_manager_v1::Request::CreateIccCreator { obj } => {
                data_init.init(obj, ());
                manager.post_error(
                    wp_color_manager_v1::Error::UnsupportedFeature,
                    "ICC profiles are not supported",
                );
            }
            wp_color_manager_v1::Request::Destroy => {}
            _ => unreachable!("version 1 has no other requests"),
        }
    }
}

impl Dispatch<WpColorManagementOutputV1, WlOutput> for DomicileCompositor {
    fn request(
        state: &mut Self,
        _: &Client,
        _: &WpColorManagementOutputV1,
        request: wp_color_management_output_v1::Request,
        output: &WlOutput,
        _: &DisplayHandle,
        data_init: &mut DataInit<'_, Self>,
    ) {
        match request {
            wp_color_management_output_v1::Request::GetImageDescription { image_description } => {
                ready(
                    data_init,
                    image_description,
                    description_of(&state.screens, output),
                    true,
                );
            }
            wp_color_management_output_v1::Request::Destroy => {}
            _ => unreachable!("version 1 has no other requests"),
        }
    }
}

impl Dispatch<WpColorManagementSurfaceV1, WlSurface> for DomicileCompositor {
    fn request(
        _: &mut Self,
        _: &Client,
        resource: &WpColorManagementSurfaceV1,
        request: wp_color_management_surface_v1::Request,
        surface: &WlSurface,
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
        let inert = || {
            resource.post_error(
                wp_color_management_surface_v1::Error::Inert,
                "the surface is gone",
            );
        };
        match request {
            wp_color_management_surface_v1::Request::SetImageDescription {
                image_description,
                render_intent,
            } => {
                if !surface.is_alive() {
                    return inert();
                }
                if !matches!(render_intent, WEnum::Value(RenderIntent::Perceptual)) {
                    resource.post_error(
                        wp_color_management_surface_v1::Error::RenderIntent,
                        "only the perceptual intent is supported",
                    );
                    return;
                }
                let Some(made) = image_description.data::<ImageDescription>() else {
                    resource.post_error(
                        wp_color_management_surface_v1::Error::ImageDescription,
                        "not an image description this compositor made",
                    );
                    return;
                };
                set_pending(surface, Some(Arc::new(made.description.clone())));
            }
            wp_color_management_surface_v1::Request::UnsetImageDescription => {
                if !surface.is_alive() {
                    return inert();
                }
                set_pending(surface, None);
            }
            wp_color_management_surface_v1::Request::Destroy => {}
            _ => unreachable!("version 1 has no other requests"),
        }
    }

    /// Destroying the object unsets the description and frees the surface
    /// for another.
    fn destroyed(_: &mut Self, _: ClientId, _: &WpColorManagementSurfaceV1, surface: &WlSurface) {
        if !surface.is_alive() {
            return;
        }
        set_pending(surface, None);
        with_states(surface, |states| {
            states
                .data_map
                .get::<ColorManaged>()
                .expect("a surface object marked its surface")
                .0
                .store(false, Ordering::Relaxed);
        });
    }
}

impl Dispatch<WpColorManagementSurfaceFeedbackV1, WlSurface> for DomicileCompositor {
    fn request(
        _: &mut Self,
        _: &Client,
        resource: &WpColorManagementSurfaceFeedbackV1,
        request: wp_color_management_surface_feedback_v1::Request,
        surface: &WlSurface,
        _: &DisplayHandle,
        data_init: &mut DataInit<'_, Self>,
    ) {
        match request {
            wp_color_management_surface_feedback_v1::Request::GetPreferred {
                image_description,
            }
            | wp_color_management_surface_feedback_v1::Request::GetPreferredParametric {
                image_description,
            } => {
                if !surface.is_alive() {
                    resource.post_error(
                        wp_color_management_surface_feedback_v1::Error::Inert,
                        "the surface is gone",
                    );
                    return;
                }
                let (description, identity) =
                    with_preferred(surface, |state| (state.description.clone(), state.identity));
                ready_as(data_init, image_description, description, true, identity);
            }
            wp_color_management_surface_feedback_v1::Request::Destroy => {}
            _ => unreachable!("version 1 has no other requests"),
        }
    }
}

impl Dispatch<WpImageDescriptionCreatorIccV1, ()> for DomicileCompositor {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WpImageDescriptionCreatorIccV1,
        _: wp_image_description_creator_icc_v1::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
        // Never reached: making one is a protocol error.
    }
}

/// What a parametric creator has been told.
#[derive(Debug, Default)]
pub struct Params {
    primaries: Option<Named>,
    transfer: Option<Transfer>,
    luminances: Option<Luminances>,
    mastering_primaries: Option<[Chromaticity; 4]>,
    mastering_luminance: Option<(f64, f64)>,
    max_cll: Option<u32>,
    max_fall: Option<u32>,
}

/// Why a parameter set makes no description.
#[derive(Debug, PartialEq)]
pub enum Refused {
    Incomplete,
    Luminance(&'static str),
}

impl Params {
    /// The description these make, as `create` checks it.
    pub fn description(&self) -> Result<Description, Refused> {
        let (Some(primaries), Some(transfer)) = (self.primaries, self.transfer) else {
            return Err(Refused::Incomplete);
        };
        let description = Description {
            primaries,
            transfer,
            luminances: self.luminances,
            mastering_primaries: self.mastering_primaries,
            mastering_luminance: self.mastering_luminance,
            max_cll: self.max_cll,
            max_fall: self.max_fall,
        };
        if let (Some(cll), Some(fall)) = (self.max_cll, self.max_fall) {
            if fall > cll {
                return Err(Refused::Luminance("max_fall is above max_cll"));
            }
        }
        // Version 1 also holds each to the target luminance range.
        let (min, max) = description.target_luminance();
        let within = |level: u32| f64::from(level) > min && f64::from(level) <= max;
        if self.max_cll.is_some_and(|cll| !within(cll)) {
            return Err(Refused::Luminance(
                "max_cll is outside the target luminance",
            ));
        }
        if self.max_fall.is_some_and(|fall| !within(fall)) {
            return Err(Refused::Luminance(
                "max_fall is outside the target luminance",
            ));
        }
        Ok(description)
    }
}

fn chromaticities(values: [i32; 8]) -> [Chromaticity; 4] {
    let at = |i: usize| Chromaticity {
        x: values[i] as f32 / 1_000_000.0,
        y: values[i + 1] as f32 / 1_000_000.0,
    };
    [at(0), at(2), at(4), at(6)]
}

impl Dispatch<WpImageDescriptionCreatorParamsV1, Mutex<Params>> for DomicileCompositor {
    fn request(
        _: &mut Self,
        _: &Client,
        creator: &WpImageDescriptionCreatorParamsV1,
        request: wp_image_description_creator_params_v1::Request,
        params: &Mutex<Params>,
        _: &DisplayHandle,
        data_init: &mut DataInit<'_, Self>,
    ) {
        use wp_image_description_creator_params_v1::{Error, Request};
        let mut params = params.lock().expect("never poisoned");
        let already_set = |what: &str| {
            creator.post_error(Error::AlreadySet, format!("{what} is already set"));
        };
        match request {
            Request::Create { image_description } => match params.description() {
                Ok(description) => ready(data_init, image_description, description, false),
                Err(Refused::Incomplete) => {
                    data_init.init(
                        image_description,
                        ImageDescription {
                            description: Description::sdr_display(),
                            information: false,
                        },
                    );
                    creator.post_error(
                        Error::IncompleteSet,
                        "a description needs a transfer function and primaries",
                    );
                }
                Err(Refused::Luminance(why)) => {
                    data_init.init(
                        image_description,
                        ImageDescription {
                            description: Description::sdr_display(),
                            information: false,
                        },
                    );
                    creator.post_error(Error::InvalidLuminance, why);
                }
            },
            Request::SetTfNamed { tf } => {
                if params.transfer.is_some() {
                    return already_set("the transfer function");
                }
                match tf.into_result().ok().and_then(Transfer::from_protocol) {
                    Some(transfer) => params.transfer = Some(transfer),
                    None => creator.post_error(Error::InvalidTf, "not an advertised name"),
                }
            }
            Request::SetPrimariesNamed { primaries } => {
                if params.primaries.is_some() {
                    return already_set("the primaries");
                }
                match primaries.into_result().ok().and_then(Named::from_protocol) {
                    Some(named) => params.primaries = Some(named),
                    None => {
                        creator.post_error(Error::InvalidPrimariesNamed, "not an advertised name")
                    }
                }
            }
            Request::SetLuminances {
                min_lum,
                max_lum,
                reference_lum,
            } => {
                if params.luminances.is_some() {
                    return already_set("the luminances");
                }
                let min = f64::from(min_lum) / 10_000.0;
                let (max, reference) = (f64::from(max_lum), f64::from(reference_lum));
                if max <= min || reference <= min {
                    return creator.post_error(
                        Error::InvalidLuminance,
                        "max and reference must be above min",
                    );
                }
                params.luminances = Some(Luminances {
                    min,
                    max,
                    reference,
                });
            }
            Request::SetMasteringDisplayPrimaries {
                r_x,
                r_y,
                g_x,
                g_y,
                b_x,
                b_y,
                w_x,
                w_y,
            } => {
                if params.mastering_primaries.is_some() {
                    return already_set("the mastering display primaries");
                }
                params.mastering_primaries =
                    Some(chromaticities([r_x, r_y, g_x, g_y, b_x, b_y, w_x, w_y]));
            }
            Request::SetMasteringLuminance { min_lum, max_lum } => {
                if params.mastering_luminance.is_some() {
                    return already_set("the mastering luminance");
                }
                let min = f64::from(min_lum) / 10_000.0;
                let max = f64::from(max_lum);
                if max <= min {
                    return creator.post_error(Error::InvalidLuminance, "max must be above min");
                }
                params.mastering_luminance = Some((min, max));
            }
            Request::SetMaxCll { max_cll } => {
                if params.max_cll.is_some() {
                    return already_set("max_cll");
                }
                params.max_cll = Some(max_cll);
            }
            Request::SetMaxFall { max_fall } => {
                if params.max_fall.is_some() {
                    return already_set("max_fall");
                }
                params.max_fall = Some(max_fall);
            }
            Request::SetTfPower { .. } => {
                creator.post_error(Error::UnsupportedFeature, "set_tf_power is not supported")
            }
            Request::SetPrimaries { .. } => {
                creator.post_error(Error::UnsupportedFeature, "set_primaries is not supported")
            }
            _ => unreachable!("version 1 has no other requests"),
        }
    }
}

impl Dispatch<WpImageDescriptionV1, ImageDescription> for DomicileCompositor {
    fn request(
        state: &mut Self,
        _: &Client,
        resource: &WpImageDescriptionV1,
        request: wp_image_description_v1::Request,
        made: &ImageDescription,
        _: &DisplayHandle,
        data_init: &mut DataInit<'_, Self>,
    ) {
        match request {
            wp_image_description_v1::Request::GetInformation { information } => {
                let info = data_init.init(information, ());
                if !made.information {
                    resource.post_error(
                        wp_image_description_v1::Error::NoInformation,
                        "only the compositor's own descriptions have information",
                    );
                    return;
                }
                // `done` destroys the object, which Wayland's backend cannot
                // take in the request that made it, so it goes once the
                // request is through.
                let description = made.description.clone();
                state
                    .loop_handle
                    .insert_idle(move |_| inform(&info, &description));
            }
            wp_image_description_v1::Request::Destroy => {}
            _ => unreachable!("version 1 has no other requests"),
        }
    }
}

impl Dispatch<WpImageDescriptionInfoV1, ()> for DomicileCompositor {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WpImageDescriptionInfoV1,
        _: <WpImageDescriptionInfoV1 as Resource>::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
        // It has no requests.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(primaries: Named, transfer: Transfer) -> Params {
        Params {
            primaries: Some(primaries),
            transfer: Some(transfer),
            ..Params::default()
        }
    }

    #[test]
    fn a_description_needs_primaries_and_a_transfer_function() {
        assert_eq!(Params::default().description(), Err(Refused::Incomplete));
        let half = Params {
            transfer: Some(Transfer::Pq),
            ..Params::default()
        };
        assert_eq!(half.description(), Err(Refused::Incomplete));
    }

    #[test]
    fn content_light_levels_must_fit_the_target_luminance() {
        let mut hdr10 = params(Named::Bt2020, Transfer::Pq);
        hdr10.mastering_luminance = Some((0.005, 1000.0));
        hdr10.max_cll = Some(1000);
        hdr10.max_fall = Some(400);
        assert!(hdr10.description().is_ok());

        hdr10.max_fall = Some(1200);
        assert!(matches!(hdr10.description(), Err(Refused::Luminance(_))));

        hdr10.max_fall = Some(400);
        hdr10.max_cll = Some(4000);
        assert!(matches!(hdr10.description(), Err(Refused::Luminance(_))));
    }

    #[test]
    fn an_srgb_description_is_srgb_to_the_engine() {
        let color = params(Named::Srgb, Transfer::Srgb)
            .description()
            .expect("complete")
            .engine_color();
        assert_eq!(
            color,
            Color {
                mastering_red: Chromaticity { x: 0.64, y: 0.33 },
                mastering_green: Chromaticity { x: 0.30, y: 0.60 },
                mastering_blue: Chromaticity { x: 0.15, y: 0.06 },
                mastering_white: Chromaticity {
                    x: 0.3127,
                    y: 0.3290
                },
                ..Color::default()
            },
            "names 0 and 0, with no metadata"
        );
    }

    #[test]
    fn hdr10_carries_its_mastering_display_and_light_levels() {
        let mut hdr10 = params(Named::Bt2020, Transfer::Pq);
        hdr10.luminances = Some(Luminances {
            min: 0.005,
            max: 10_000.0,
            reference: 300.0,
        });
        hdr10.mastering_primaries = Some(Named::DisplayP3.chromaticities());
        hdr10.mastering_luminance = Some((0.005, 1000.0));
        hdr10.max_cll = Some(900);
        hdr10.max_fall = Some(300);

        let color = hdr10.description().expect("valid").engine_color();

        assert_eq!((color.primaries, color.transfer), (1, 4));
        assert_eq!(color.reference_luminance, 300.0);
        assert_eq!(color.has_mastering, 1);
        assert_eq!(color.mastering_red, Chromaticity { x: 0.680, y: 0.320 });
        assert_eq!(
            (color.mastering_min_luminance, color.mastering_max_luminance),
            (0.005, 1000.0)
        );
        assert_eq!((color.max_cll, color.max_fall), (900.0, 300.0));
    }

    #[test]
    fn windows_scrgb_is_its_own_transfer_function() {
        let color = Description::named(Named::Srgb, Transfer::WindowsScrgb).engine_color();
        assert_eq!((color.primaries, color.transfer), (0, 6));
    }

    #[test]
    fn chromaticities_are_millionths() {
        assert_eq!(
            millionths(&Named::Srgb.chromaticities()),
            [640_000, 330_000, 300_000, 600_000, 150_000, 60_000, 312_700, 329_000]
        );
        assert_eq!(
            chromaticities(millionths(&Named::Bt2020.chromaticities())),
            Named::Bt2020.chromaticities()
        );
    }

    fn hdr(state: HdrState) -> Hdr {
        Hdr {
            state,
            max_luminance: 600,
            max_average_luminance: 400,
            min_luminance: 500,
            sdr_white: if state == HdrState::On { 240 } else { 0 },
        }
    }

    #[test]
    fn a_display_not_driven_in_hdr_is_srgb_with_gamma_2_2() {
        for state in [HdrState::Unsupported, HdrState::Off] {
            assert_eq!(
                Description::of_display(&hdr(state)),
                Description::sdr_display()
            );
        }
    }

    #[test]
    fn a_display_in_hdr_is_hdr10_with_its_sdr_white_and_its_panels_range() {
        let description = Description::of_display(&hdr(HdrState::On));
        assert_eq!(
            (description.primaries, description.transfer),
            (Named::Bt2020, Transfer::Pq)
        );
        assert_eq!(
            description.luminances,
            Some(Luminances {
                min: 0.05,
                max: 10_000.0,
                reference: 240.0,
            }),
            "SDR white is its reference, as the engine draws it"
        );
        assert_eq!(description.target_luminance(), (0.05, 600.0));
    }

    #[test]
    fn a_panel_that_reports_no_luminances_gets_pqs_own() {
        let quiet = Hdr {
            state: HdrState::On,
            sdr_white: 203,
            ..Hdr::default()
        };
        let description = Description::of_display(&quiet);
        assert_eq!(description.luminances().min, 0.005);
        assert_eq!(description.target_luminance(), (0.005, 10_000.005));
    }

    #[test]
    fn pq_reaches_ten_thousand_nits_above_its_minimum() {
        let pq = Description::named(Named::Bt2020, Transfer::Pq);
        assert_eq!(pq.target_luminance(), (0.005, 10_000.005));
    }
}
