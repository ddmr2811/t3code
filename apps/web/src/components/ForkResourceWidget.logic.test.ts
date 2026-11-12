import { describe, expect, it } from "vite-plus/test";

import {
  forkWidgetDefaultSize,
  forkWidgetScale,
  parseForkWidgetBounds,
} from "./ForkResourceWidget.logic";

describe("forkWidgetScale", () => {
  it("leaves the default window at its natural size", () => {
    const size = forkWidgetDefaultSize(2);
    expect(forkWidgetScale({ ...size, machineCount: 2 })).toBe(1);
  });

  it("grows the content with the window", () => {
    expect(forkWidgetScale({ width: 1040, height: 272, machineCount: 2 })).toBe(2);
  });

  it("is held back by whichever side has less room", () => {
    expect(forkWidgetScale({ width: 2000, height: 136, machineCount: 2 })).toBe(1);
    expect(forkWidgetScale({ width: 520, height: 900, machineCount: 2 })).toBe(1);
  });

  it("shrinks so that more machines still fit", () => {
    expect(forkWidgetScale({ width: 520, height: 136, machineCount: 4 })).toBeLessThan(1);
  });

  it("stays within sane limits", () => {
    expect(forkWidgetScale({ width: 10, height: 10, machineCount: 2 })).toBe(0.6);
    expect(forkWidgetScale({ width: 9000, height: 9000, machineCount: 1 })).toBe(3);
    expect(forkWidgetScale({ width: 0, height: 0, machineCount: 0 })).toBe(1);
  });
});

describe("forkWidgetDefaultSize", () => {
  it("makes room for every machine", () => {
    expect(forkWidgetDefaultSize(5).height).toBeGreaterThan(forkWidgetDefaultSize(2).height);
    expect(forkWidgetScale({ ...forkWidgetDefaultSize(5), machineCount: 5 })).toBe(1);
  });
});

describe("parseForkWidgetBounds", () => {
  it("reads a position saved before sizes were remembered", () => {
    expect(parseForkWidgetBounds('{"left":10,"top":20}')).toEqual({ left: 10, top: 20 });
  });

  it("reads a position with its size", () => {
    expect(parseForkWidgetBounds('{"left":10,"top":20,"width":700,"height":300}')).toEqual({
      left: 10,
      top: 20,
      width: 700,
      height: 300,
    });
  });

  it("drops a size smaller than the window can be", () => {
    expect(parseForkWidgetBounds('{"left":1,"top":2,"width":50,"height":300}')).toEqual({
      left: 1,
      top: 2,
    });
  });

  it("ignores anything malformed", () => {
    expect(parseForkWidgetBounds(null)).toBeNull();
    expect(parseForkWidgetBounds("not json")).toBeNull();
    expect(parseForkWidgetBounds('{"left":"a","top":2}')).toBeNull();
  });
});
