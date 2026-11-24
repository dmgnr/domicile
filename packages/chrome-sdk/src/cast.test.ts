import { describe, expect, it } from "bun:test";
import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";

import type { Cast, CastBackend, CastTarget, Sending } from "./cast";
import {
  CastClaimKind,
  CastMode,
  casting,
  claimCastRequest,
  engineCast,
} from "./cast";
import { desktop } from "./desktop/desktop";
import type { GoogleCast } from "./desktop/google-cast";
import type { DomicileCastSink, DomicileDisplay } from "./domicile-host";
import { FakeDomicileHost } from "./fake-host";
import type { PortalRequest } from "./portal";
import { CastSource, PortalAnswer, PortalRequest as Request } from "./portal";
import type { SystemError, VirtualMonitor, VirtualMonitorMode } from "./system";
import { SystemErrorKind } from "./system";

const TV: CastTarget = {
  id: "tv-1",
  mode: { height: 1080, refreshMhz: 60_000, width: 1920 },
  name: "Living Room TV",
  unreachable: undefined,
};

const display = (name: string): DomicileDisplay => ({
  adaptiveSync: "unsupported",
  hdr: "unsupported",
  height: 1080,
  modeHeight: 1080,
  modeWidth: 1920,
  name,
  peakLuminance: 0,
  refreshMhz: 60_000,
  scale: 1,
  sdrWhite: 0,
  transform: "normal",
  width: 1920,
  x: 0,
  y: 0,
});

/** A backend whose sends the test settles. */
class FakeBackend implements CastBackend {
  readonly appId = "";
  readonly sent: string[] = [];
  readonly stopped: string[] = [];
  readonly #replies: ((reply: Result<Sending, string>) => void)[] = [];
  readonly #ends: (() => void)[] = [];

  watchTargets(listener: (targets: readonly CastTarget[]) => void) {
    listener([TV]);
    return () => undefined;
  }

  send(targetId: string): Promise<Result<Sending, string>> {
    this.sent.push(targetId);
    return new Promise((resolve) => {
      this.#replies.push(resolve);
    });
  }

  /** The TV takes the oldest send. */
  take(): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#ends.push(resolve);
    this.#replies.shift()?.(
      Ok({
        ended: promise,
        stop: () => {
          this.stopped.push("stop");
          resolve();
        },
      }),
    );
  }

  /** The TV refuses the oldest send. */
  refuse(why: string): void {
    this.#replies.shift()?.(Err(why));
  }

  /** The TV hangs up the oldest cast. */
  hangUp(): void {
    this.#ends.shift()?.();
  }
}

/** A compositor's virtual monitors, which the test shows and ends. */
class FakeMonitors {
  readonly added: VirtualMonitorMode[] = [];
  readonly removed: string[] = [];
  refusal: SystemError | undefined;
  readonly #ends = new Map<
    string,
    (end: Result<"removed", SystemError>) => void
  >();

  addVirtual = (
    mode: VirtualMonitorMode,
  ): Promise<Result<VirtualMonitor, SystemError>> => {
    if (this.refusal !== undefined) {
      return Promise.resolve(Err(this.refusal));
    }
    this.added.push(mode);
    const output = `virtual-${this.added.length}`;
    const { promise, resolve } =
      Promise.withResolvers<Result<"removed", SystemError>>();
    this.#ends.set(output, resolve);
    return Promise.resolve(
      Ok({
        ended: promise,
        output,
        remove: () => {
          this.removed.push(output);
          resolve(Ok("removed"));
        },
        resize: () => {
          /* never resized */
        },
      }),
    );
  };

  /** The compositor went away, taking `output` with it. */
  lose(output: string): void {
    this.#ends.get(output)?.(
      Err({ kind: SystemErrorKind.Other, message: "compositor went away" }),
    );
  }
}

const screenCast = (
  appId: string,
  monitors: readonly string[],
): PortalRequest =>
  Request.ScreenCast(
    { appId, id: 9, parentAppId: undefined },
    {
      browserWindows: false,
      desk: undefined,
      multiple: false,
      region: false,
      sources: monitors.map((name) =>
        CastSource.Monitor({ description: "", name, size: [1920, 1080] }),
      ),
    },
  );

/** The started cast, or a failure that names why. */
const taken = (result: Result<Cast, string>): Cast =>
  result.match({
    Err: (why) => {
      throw new Error(`the cast failed: ${why}`);
    },
    Ok: (cast) => cast,
  });

/** Lets the casts' awaits run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const desk = () => {
  const fake = new FakeDomicileHost();
  fake.set({ displays: [display("left")] });
  const monitors = new FakeMonitors();
  return { cast: casting(desktop(fake.host), monitors), fake, monitors };
};

describe("casting", () => {
  it("is the same casts for every caller with the host", () => {
    const { cast, fake } = desk();

    expect(casting(desktop(fake.host))).toBe(cast);
  });

  describe("to pick what to show", () => {
    it("sends to the TV, and has the share picker ask, titled for it", async () => {
      const { cast, fake } = desk();
      const backend = new FakeBackend();
      void cast.start(backend, TV, CastMode.Pick);
      await settle();

      expect(backend.sent).toEqual(["tv-1"]);
      expect(
        claimCastRequest(desktop(fake.host), screenCast("", ["left"])),
      ).toEqual({
        kind: CastClaimKind.Pick,
        to: "Living Room TV",
      });
    });

    it("claims one request, leaving the next to its application", async () => {
      const { cast, fake } = desk();
      void cast.start(new FakeBackend(), TV, CastMode.Pick);
      await settle();
      claimCastRequest(desktop(fake.host), screenCast("", ["left"]));

      expect(
        claimCastRequest(desktop(fake.host), screenCast("", ["left"])),
      ).toBeUndefined();
    });

    it("leaves another application's request to it", async () => {
      const { cast, fake } = desk();
      void cast.start(new FakeBackend(), TV, CastMode.Pick);
      await settle();

      expect(
        claimCastRequest(
          desktop(fake.host),
          screenCast("us.zoom.Zoom", ["left"]),
        ),
      ).toBeUndefined();
    });

    it("claims any application's request for a backend that cannot say", async () => {
      const { cast, fake } = desk();
      const backend = new FakeBackend();
      Object.defineProperty(backend, "appId", { value: undefined });
      void cast.start(backend, TV, CastMode.Pick);
      await settle();

      expect(
        claimCastRequest(
          desktop(fake.host),
          screenCast("org.chromium", ["left"]),
        ),
      ).toEqual({ kind: CastClaimKind.Pick, to: "Living Room TV" });
    });

    it("lists the cast once the TV takes it, until it stops", async () => {
      const { cast } = desk();
      const backend = new FakeBackend();
      const seen: number[] = [];
      cast.watch((casts) => seen.push(casts.length));
      const started = cast.start(backend, TV, CastMode.Pick);
      await settle();
      backend.take();
      taken(await started).stop();
      await settle();

      expect(seen).toEqual([0, 1, 0]);
      expect(backend.stopped).toEqual(["stop"]);
    });

    it("says why the TV refused, and forgets the request it waited on", async () => {
      const { cast, fake } = desk();
      const backend = new FakeBackend();
      const started = cast.start(backend, TV, CastMode.Pick);
      await settle();
      backend.refuse("The TV is busy");

      expect(await started).toStrictEqual(Err("The TV is busy"));
      expect(
        claimCastRequest(desktop(fake.host), screenCast("", ["left"])),
      ).toBeUndefined();
    });
  });

  describe("to extend the desk", () => {
    it("adds a monitor at the TV's mode, named for it", async () => {
      const { cast, monitors } = desk();
      void cast.start(new FakeBackend(), TV, CastMode.Extend);
      await settle();

      expect(monitors.added).toEqual([
        {
          height: 1080,
          name: "Living Room TV",
          refreshMhz: 60_000,
          width: 1920,
        },
      ]);
    });

    it("sends once the monitor is a display, and answers with it", async () => {
      const { cast, fake } = desk();
      const backend = new FakeBackend();
      void cast.start(backend, TV, CastMode.Extend);
      await settle();

      expect(backend.sent).toEqual([]);
      fake.set({ displays: [display("left"), display("virtual-1")] });
      await settle();

      expect(backend.sent).toEqual(["tv-1"]);
      expect(
        claimCastRequest(
          desktop(fake.host),
          screenCast("", ["left", "virtual-1"]),
        ),
      ).toEqual({
        answer: PortalAnswer.ScreenCast([
          CastSource.Monitor({
            description: "",
            name: "virtual-1",
            size: [1920, 1080],
          }),
        ]),
        kind: CastClaimKind.Answered,
      });
    });

    it("cancels a request that does not offer the monitor", async () => {
      const { cast, fake } = desk();
      fake.set({ displays: [display("left"), display("virtual-1")] });
      void cast.start(new FakeBackend(), TV, CastMode.Extend);
      await settle();

      expect(
        claimCastRequest(desktop(fake.host), screenCast("", ["left"])),
      ).toEqual({
        answer: PortalAnswer.Canceled(),
        kind: CastClaimKind.Answered,
      });
    });

    it("removes the monitor when the cast stops", async () => {
      const { cast, fake, monitors } = desk();
      fake.set({ displays: [display("left"), display("virtual-1")] });
      const backend = new FakeBackend();
      const started = cast.start(backend, TV, CastMode.Extend);
      await settle();
      backend.take();
      taken(await started).stop();
      await settle();

      expect(monitors.removed).toEqual(["virtual-1"]);
    });

    it("removes the monitor when the TV hangs up", async () => {
      const { cast, fake, monitors } = desk();
      fake.set({ displays: [display("left"), display("virtual-1")] });
      const backend = new FakeBackend();
      void cast.start(backend, TV, CastMode.Extend);
      await settle();
      backend.take();
      await settle();
      backend.hangUp();
      await settle();

      expect(monitors.removed).toEqual(["virtual-1"]);
    });

    it("removes the monitor when the TV refuses", async () => {
      const { cast, fake, monitors } = desk();
      fake.set({ displays: [display("left"), display("virtual-1")] });
      const backend = new FakeBackend();
      void cast.start(backend, TV, CastMode.Extend);
      await settle();
      backend.refuse("The TV is busy");
      await settle();

      expect(monitors.removed).toEqual(["virtual-1"]);
    });

    it("stops sending when the monitor goes with its compositor", async () => {
      const { cast, fake, monitors } = desk();
      fake.set({ displays: [display("left"), display("virtual-1")] });
      const backend = new FakeBackend();
      void cast.start(backend, TV, CastMode.Extend);
      await settle();
      backend.take();
      await settle();
      monitors.lose("virtual-1");
      await settle();

      expect(backend.stopped).toEqual(["stop"]);
    });

    it("says so when the monitor goes before it is shown", async () => {
      const { cast, monitors } = desk();
      const backend = new FakeBackend();
      const started = cast.start(backend, TV, CastMode.Extend);
      await settle();
      monitors.lose("virtual-1");

      expect(await started).toStrictEqual(
        Err("Living Room TV went away before it was shown"),
      );
      expect(backend.sent).toEqual([]);
    });

    it("says why the compositor refused the monitor", async () => {
      const { cast, monitors } = desk();
      monitors.refusal = {
        kind: SystemErrorKind.Other,
        message: "the config describes the desktop",
      };

      expect(
        await cast.start(new FakeBackend(), TV, CastMode.Extend),
      ).toStrictEqual(Err("the config describes the desktop"));
    });
  });
});

/** The engine's TVs, whose casts the test settles. */
const engine = () => {
  const fake = new FakeDomicileHost();
  const { googleCast } = desktop(fake.host);
  const started: string[] = [];
  const stopped: string[] = [];
  const replies: ((reply: Result<string, string>) => void)[] = [];
  const cast: GoogleCast = {
    cast: (id) => {
      started.push(id);
      const { promise, resolve } =
        Promise.withResolvers<Result<string, string>>();
      replies.push(resolve);
      return promise;
    },
    on: googleCast.on,
    get receivers() {
      return googleCast.receivers;
    },
    stop: (route) => {
      stopped.push(route);
    },
  };
  const sinks = (...listed: DomicileCastSink[]) => {
    fake.set({ castSinks: listed });
  };
  return { backend: engineCast(cast), replies, sinks, started, stopped };
};

const sink = (route: string | null = null): DomicileCastSink => ({
  id: "tv-1",
  name: "Living Room TV",
  route,
});

describe("engineCast", () => {
  it("lists the engine's TVs, at 1080p, as they change", () => {
    const { backend, sinks } = engine();
    const heard: (readonly CastTarget[])[] = [];
    backend.watchTargets((targets) => {
      heard.push(targets);
    });
    sinks(sink());

    expect(heard).toEqual([[], [TV]]);
  });

  it("claims any app's request: the engine's capture names none it picks", () => {
    expect(engine().backend.appId).toBeUndefined();
  });

  it("casts to the TV, and stops its route", async () => {
    const { backend, replies, started, stopped } = engine();
    const sending = backend.send("tv-1");
    replies[0]?.(Ok("route-1"));
    const sent = await sending;
    sent.match({
      Err: () => undefined,
      Ok: ({ stop }) => {
        stop();
      },
    });

    expect(started).toEqual(["tv-1"]);
    expect(stopped).toEqual(["route-1"]);
  });

  it("says why the TV refused", async () => {
    const { backend, replies } = engine();
    const sending = backend.send("tv-1");
    replies[0]?.(Err("The TV did not take the cast"));

    expect(await sending).toStrictEqual(Err("The TV did not take the cast"));
  });

  it("ends once the TV's route goes, whether listed before or after", async () => {
    const { backend, replies, sinks } = engine();
    const sending = backend.send("tv-1");
    sinks(sink("route-1"));
    replies[0]?.(Ok("route-1"));
    let ended = false;
    (await sending).match({
      Err: () => undefined,
      Ok: (sent) => {
        void sent.ended.then(() => {
          ended = true;
        });
      },
    });
    sinks(sink("route-1"));
    await settle();
    expect(ended).toBe(false);

    sinks(sink());
    await settle();
    expect(ended).toBe(true);
  });

  it("does not end before the list first names the route", async () => {
    const { backend, replies, sinks } = engine();
    const sending = backend.send("tv-1");
    replies[0]?.(Ok("route-1"));
    let ended = false;
    (await sending).match({
      Err: () => undefined,
      Ok: (sent) => {
        void sent.ended.then(() => {
          ended = true;
        });
      },
    });
    sinks(sink());
    await settle();

    expect(ended).toBe(false);
  });
});
