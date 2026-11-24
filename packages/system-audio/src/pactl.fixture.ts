// Recorded `pactl -f json` output, trimmed to the fields read.

/** `pactl -f json info`. */
export const INFO = `{"server_name":"PulseAudio (on PipeWire 1.2.7)","default_sink_name":"alsa_output.analog-stereo","default_source_name":"alsa_input.analog-stereo"}`;

/** `pactl -f json list`, one of each kind. */
export const LIST = `{
  "modules": [],
  "sinks": [
    {"index": 51, "name": "alsa_output.analog-stereo", "description": "Built-in Audio Analog Stereo",
     "mute": false, "monitor_source": "alsa_output.analog-stereo.monitor",
     "volume": {"front-left": {"value": 32768, "value_percent": "50%", "db": "-18.06 dB"},
                "front-right": {"value": 39322, "value_percent": "60%", "db": "-13.31 dB"}},
     "properties": {},
     "ports": [
       {"name": "analog-output-speaker", "description": "Speakers", "priority": 10000, "availability": "availability unknown"},
       {"name": "analog-output-headphones", "description": "Headphones", "priority": 9900, "availability": "not available"}
     ],
     "active_port": "analog-output-speaker"},
    {"index": 60, "name": "hdmi", "description": "HDMI", "mute": true,
     "volume": {"error": "(invalid)"}, "properties": {}, "ports": [], "active_port": null}
  ],
  "sources": [
    {"index": 52, "name": "alsa_output.analog-stereo.monitor", "description": "Monitor of Built-in Audio Analog Stereo",
     "mute": false, "volume": {"front-left": {"value": 65536}}, "monitor_source": "alsa_output.analog-stereo",
     "properties": {}, "ports": [], "active_port": null},
    {"index": 53, "name": "alsa_input.analog-stereo", "description": "Built-in Audio Analog Stereo",
     "mute": true, "volume": {"mono": {"value": 16384}}, "monitor_source": null,
     "properties": {}, "ports": [{"name": "analog-input-mic", "description": "Microphone", "availability": "available"}],
     "active_port": "analog-input-mic"}
  ],
  "sink_inputs": [
    {"index": 42, "sink": 51, "mute": false, "volume": {"front-left": {"value": 65536}},
     "properties": {"application.name": "Firefox", "media.name": "A song"}},
    {"index": 43, "sink": 51, "mute": false, "volume": {"mono": {"value": 65536}},
     "properties": {"media.name": "bell"}},
    {"index": 44, "sink": 99, "mute": false, "volume": {"mono": {"value": 65536}},
     "properties": {"application.name": "late"}},
    {"index": 45, "sink": 51, "mute": false, "volume": {"mono": {"value": 65536}},
     "properties": {"application.name": "Volume Control", "application.id": "org.PulseAudio.pavucontrol"}}
  ],
  "source_outputs": [
    {"index": 7, "source": 53, "mute": true, "volume": {"mono": {"value": 16384}},
     "properties": {"application.name": "Recorder"}}
  ],
  "clients": [],
  "samples": [],
  "cards": [
    {"index": 1, "name": "alsa_card.pci", "properties": {"device.description": "Built-in Audio"},
     "profiles": {
       "off": {"description": "Off", "sinks": 0, "sources": 0, "priority": 0, "available": true},
       "output:hdmi-stereo": {"description": "Digital Stereo (HDMI) Output", "priority": 5900, "available": false},
       "output:analog-stereo": {"description": "Analog Stereo Output", "priority": 6500, "available": true}
     },
     "active_profile": "output:analog-stereo"},
    {"index": 2, "name": "bluez_card.00_11", "properties": {}, "profiles": {}, "active_profile": null}
  ]
}`;

/**
 * {@link LIST} behind a laptop's speaker correction: a filter sink to play
 * to, and its stream into the hardware, tied by their link group. The
 * hardware is muted.
 */
export const FILTERED_LIST = LIST.replace(
  `"sinks": [`,
  `"sinks": [
    {"index": 76, "name": "audio_effect.laptop-convolver", "description": "Framework Speakers",
     "mute": false, "volume": {"front-left": {"value": 45875}}, "monitor_source": "audio_effect.laptop-convolver.monitor",
     "properties": {"node.link-group": "filter-chain-3901-18"}, "ports": [], "active_port": null},`,
)
  .replace(
    `"sink_inputs": [`,
    `"sink_inputs": [
    {"index": 77, "sink": 51, "mute": false, "volume": {"mono": {"value": 65536}},
     "properties": {"media.name": "Framework Speakers", "node.link-group": "filter-chain-3901-18"}},`,
  )
  .replace(
    `"description": "Built-in Audio Analog Stereo",
     "mute": false,`,
    `"description": "Built-in Audio Analog Stereo",
     "mute": true,`,
  );
