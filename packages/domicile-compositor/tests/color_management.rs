//! `wp_color_management_v1`: a client describes how its pixels encode color,
//! and asks how a display would like them.
//!
//! No engine runs here, so these cover the protocol. How a description turns
//! into the engine's color is unit tested in `src/color_management.rs`; how
//! viz draws it is the engine's `BufferColorTest` and a hardware check.

mod running;

use std::os::unix::net::UnixStream;

use wayland_client::protocol::{wl_compositor, wl_output, wl_registry, wl_surface};
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle, WEnum};
use wayland_protocols::wp::color_management::v1::client::{
    wp_color_management_output_v1::WpColorManagementOutputV1,
    wp_color_management_surface_feedback_v1::{self, WpColorManagementSurfaceFeedbackV1},
    wp_color_management_surface_v1::WpColorManagementSurfaceV1,
    wp_color_manager_v1::{self, Feature, Primaries, TransferFunction, WpColorManagerV1},
    wp_image_description_creator_params_v1::WpImageDescriptionCreatorParamsV1,
    wp_image_description_info_v1::{self, WpImageDescriptionInfoV1},
    wp_image_description_v1::{self, WpImageDescriptionV1},
};

use crate::running::Compositor;

/// One monitor.
const A_DISPLAY: &str = r#"
{ "output": { "displays": [{ "name": "only", "size": [320, 240] }] } }
"#;

#[derive(Default)]
struct Client {
    manager: Option<WpColorManagerV1>,
    compositor: Option<wl_compositor::WlCompositor>,
    output: Option<wl_output::WlOutput>,
    features: Vec<Feature>,
    transfer_functions: Vec<TransferFunction>,
    primaries: Vec<Primaries>,
    listed: bool,
    ready: Vec<u32>,
    failed: bool,
    named_tf: Option<TransferFunction>,
    named_primaries: Option<Primaries>,
    luminances: Option<(u32, u32, u32)>,
    informed: bool,
    preferred_changed: bool,
}

fn connect(compositor: &Compositor) -> (EventQueue<Client>, Client) {
    let socket = UnixStream::connect(compositor.scratch_file(compositor.wayland_display()))
        .expect("the apps' display takes a connection");
    let connection = Connection::from_socket(socket).expect("a Wayland connection");
    let mut queue = connection.new_event_queue();
    connection.display().get_registry(&queue.handle(), ());
    let mut client = Client::default();
    queue.roundtrip(&mut client).expect("globals listed");
    queue
        .roundtrip(&mut client)
        .expect("the manager listed what it supports");
    assert!(
        client.manager.is_some(),
        "the compositor advertises wp_color_manager_v1"
    );
    (queue, client)
}

#[test]
fn the_manager_lists_parametric_descriptions_and_its_names() {
    let compositor = Compositor::started_with(A_DISPLAY);
    let (_queue, client) = connect(&compositor);

    assert!(client.listed, "done follows the list");
    for feature in [
        Feature::Parametric,
        Feature::SetLuminances,
        Feature::SetMasteringDisplayPrimaries,
        Feature::WindowsScrgb,
    ] {
        assert!(client.features.contains(&feature), "{feature:?} is listed");
    }
    assert!(
        !client.features.contains(&Feature::IccV2V4),
        "ICC is not listed"
    );
    for tf in [
        TransferFunction::Srgb,
        TransferFunction::Gamma22,
        TransferFunction::St2084Pq,
        TransferFunction::Hlg,
        TransferFunction::ExtLinear,
    ] {
        assert!(client.transfer_functions.contains(&tf), "{tf:?} is listed");
    }
    for primaries in [Primaries::Srgb, Primaries::Bt2020, Primaries::DisplayP3] {
        assert!(
            client.primaries.contains(&primaries),
            "{primaries:?} is listed"
        );
    }
}

#[test]
fn an_hdr10_description_is_ready_and_a_surface_takes_it() {
    let compositor = Compositor::started_with(A_DISPLAY);
    let (mut queue, mut client) = connect(&compositor);
    let handle = queue.handle();
    let manager = client.manager.clone().expect("bound");
    let surface = client
        .compositor
        .as_ref()
        .expect("a wl_compositor")
        .create_surface(&handle, ());

    let creator = manager.create_parametric_creator(&handle, ());
    creator.set_primaries_named(Primaries::Bt2020);
    creator.set_tf_named(TransferFunction::St2084Pq);
    creator.set_mastering_luminance(50, 1000);
    creator.set_max_cll(1000);
    creator.set_max_fall(400);
    let description = creator.create(&handle, ());
    queue
        .roundtrip(&mut client)
        .expect("the description answered");
    assert_eq!(client.ready.len(), 1, "{}", compositor.complaint());
    assert!(!client.failed);

    let managed = manager.get_surface(&surface, &handle, ());
    managed.set_image_description(&description, wp_color_manager_v1::RenderIntent::Perceptual);
    surface.commit();
    queue
        .roundtrip(&mut client)
        .expect("the surface took its description");
}

#[test]
fn a_surface_has_one_color_management_object() {
    let compositor = Compositor::started_with(A_DISPLAY);
    let (mut queue, mut client) = connect(&compositor);
    let handle = queue.handle();
    let manager = client.manager.clone().expect("bound");
    let surface = client
        .compositor
        .as_ref()
        .expect("a wl_compositor")
        .create_surface(&handle, ());

    let _first = manager.get_surface(&surface, &handle, ());
    let _second = manager.get_surface(&surface, &handle, ());

    assert!(
        queue.roundtrip(&mut client).is_err(),
        "a second object for one surface is a protocol error"
    );
}

#[test]
fn a_display_describes_itself_as_srgb_with_gamma_2_2() {
    let compositor = Compositor::started_with(A_DISPLAY);
    let (mut queue, mut client) = connect(&compositor);
    let handle = queue.handle();
    let manager = client.manager.clone().expect("bound");
    let output = client.output.clone().expect("a wl_output");

    let described = manager.get_output(&output, &handle, ());
    let description = described.get_image_description(&handle, ());
    queue
        .roundtrip(&mut client)
        .expect("the description answered");
    assert_eq!(client.ready.len(), 1, "{}", compositor.complaint());
    let _info = description.get_information(&handle, ());
    queue
        .roundtrip(&mut client)
        .unwrap_or_else(|error| panic!("{error}: {}", compositor.complaint()));
    // The information follows the request's own round trip.
    queue
        .roundtrip(&mut client)
        .expect("the information arrived");

    assert!(client.informed, "done ends the information");
    assert_eq!(client.named_primaries, Some(Primaries::Srgb));
    assert_eq!(client.named_tf, Some(TransferFunction::Gamma22));
    assert_eq!(client.luminances, Some((2000, 80, 80)));
}

#[test]
fn a_surface_prefers_one_description_until_its_display_changes() {
    let compositor = Compositor::started_with(A_DISPLAY);
    let (mut queue, mut client) = connect(&compositor);
    let handle = queue.handle();
    let manager = client.manager.clone().expect("bound");
    let surface = client
        .compositor
        .as_ref()
        .expect("a wl_compositor")
        .create_surface(&handle, ());

    let feedback = manager.get_surface_feedback(&surface, &handle, ());
    let first = feedback.get_preferred_parametric(&handle, ());
    let second = feedback.get_preferred(&handle, ());
    queue
        .roundtrip(&mut client)
        .unwrap_or_else(|error| panic!("{error}: {}", compositor.complaint()));
    assert_eq!(client.ready.len(), 2, "{}", compositor.complaint());
    assert_eq!(
        client.ready[0], client.ready[1],
        "one description is one identity, so a client can tell it has not changed"
    );

    let _info = first.get_information(&handle, ());
    queue
        .roundtrip(&mut client)
        .unwrap_or_else(|error| panic!("{error}: {}", compositor.complaint()));
    queue
        .roundtrip(&mut client)
        .expect("the information arrived");
    assert_eq!(
        client.named_tf,
        Some(TransferFunction::Gamma22),
        "an SDR display"
    );
    assert!(!client.preferred_changed, "nothing changed");
    drop(second);
}

impl Dispatch<wl_registry::WlRegistry, ()> for Client {
    fn event(
        client: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        handle: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name, interface, ..
        } = event
        {
            match interface.as_str() {
                "wp_color_manager_v1" => {
                    client.manager = Some(registry.bind(name, 1, handle, ()));
                }
                "wl_compositor" => client.compositor = Some(registry.bind(name, 4, handle, ())),
                "wl_output" => client.output = Some(registry.bind(name, 1, handle, ())),
                _ => {}
            }
        }
    }
}

impl Dispatch<WpColorManagerV1, ()> for Client {
    fn event(
        client: &mut Self,
        _: &WpColorManagerV1,
        event: wp_color_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wp_color_manager_v1::Event::SupportedFeature {
                feature: WEnum::Value(feature),
            } => client.features.push(feature),
            wp_color_manager_v1::Event::SupportedTfNamed {
                tf: WEnum::Value(tf),
            } => client.transfer_functions.push(tf),
            wp_color_manager_v1::Event::SupportedPrimariesNamed {
                primaries: WEnum::Value(primaries),
            } => client.primaries.push(primaries),
            wp_color_manager_v1::Event::Done => client.listed = true,
            _ => {}
        }
    }
}

impl Dispatch<WpImageDescriptionV1, ()> for Client {
    fn event(
        client: &mut Self,
        _: &WpImageDescriptionV1,
        event: wp_image_description_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wp_image_description_v1::Event::Ready { identity } => client.ready.push(identity),
            wp_image_description_v1::Event::Failed { .. } => client.failed = true,
            _ => {}
        }
    }
}

impl Dispatch<WpImageDescriptionInfoV1, ()> for Client {
    fn event(
        client: &mut Self,
        _: &WpImageDescriptionInfoV1,
        event: wp_image_description_info_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wp_image_description_info_v1::Event::PrimariesNamed {
                primaries: WEnum::Value(primaries),
            } => client.named_primaries = Some(primaries),
            wp_image_description_info_v1::Event::TfNamed {
                tf: WEnum::Value(tf),
            } => client.named_tf = Some(tf),
            wp_image_description_info_v1::Event::Luminances {
                min_lum,
                max_lum,
                reference_lum,
            } => client.luminances = Some((min_lum, max_lum, reference_lum)),
            wp_image_description_info_v1::Event::Done => client.informed = true,
            _ => {}
        }
    }
}

impl Dispatch<WpColorManagementSurfaceFeedbackV1, ()> for Client {
    fn event(
        client: &mut Self,
        _: &WpColorManagementSurfaceFeedbackV1,
        event: wp_color_management_surface_feedback_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wp_color_management_surface_feedback_v1::Event::PreferredChanged { .. } = event {
            client.preferred_changed = true;
        }
    }
}

wayland_client::delegate_noop!(Client: ignore wl_compositor::WlCompositor);
wayland_client::delegate_noop!(Client: ignore wl_surface::WlSurface);
wayland_client::delegate_noop!(Client: ignore wl_output::WlOutput);
wayland_client::delegate_noop!(Client: ignore WpColorManagementOutputV1);
wayland_client::delegate_noop!(Client: ignore WpColorManagementSurfaceV1);
wayland_client::delegate_noop!(Client: ignore WpImageDescriptionCreatorParamsV1);
