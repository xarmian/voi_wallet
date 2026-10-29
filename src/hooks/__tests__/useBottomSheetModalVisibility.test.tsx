/**
 * useBottomSheetModalVisibility tests (TASK-432).
 *
 * These run the REAL installed @gorhom/bottom-sheet BottomSheetModal (its
 * compiled lib, same status machine as the src Metro bundles), so the
 * DISMISSING latch from gorhom/react-native-bottom-sheet#2669 is the library's
 * own. Mocked: the inner animated BottomSheet (a controllable stand-in), the
 * portal host, the provider context and the logger. Frames and animation
 * callbacks are driven by hand so each case can land a visibility change in
 * the exact gap a real device can hit:
 *   - requestAnimationFrame: present() defers its work to a frame;
 *   - startOpen(): the inner sheet starts animating (modal onAnimate);
 *   - settle(): the open animation lands (modal onChange(index));
 *   - finishClose(): a close animation lands (onChange(-1), then onClose).
 *
 * The Host mirrors the app's wrappers: an onChange(-1) calls the parent's
 * onClose, which sets isVisible=false.
 */

import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { act, render } from '@testing-library/react-native';
import type { BottomSheetModal as BottomSheetModalType } from '@gorhom/bottom-sheet';

import { useBottomSheetModalVisibility } from '../useBottomSheetModalVisibility';

type SheetProps = {
  index: number;
  onAnimate: (from: number, to: number, fromPos: number, toPos: number) => void;
  onChange: (index: number, position: number, type: number) => void;
  onClose: () => void;
};

// The mounted inner sheet, if any. Reset per test.
const mockSheet: {
  props: SheetProps | null;
  forced: boolean;
  snaps: number;
} = { props: null, forced: false, snaps: 0 };

jest.mock('@gorhom/bottom-sheet/lib/commonjs/components/bottomSheet', () => {
  const ReactLib = jest.requireActual('react');
  const Sheet = ReactLib.forwardRef(
    (props: SheetProps, ref: React.Ref<unknown>) => {
      mockSheet.props = props;
      ReactLib.useImperativeHandle(ref, () => ({
        snapToIndex: () => {
          // BottomSheet refuses a snap while a forced close is running.
          if (!mockSheet.forced) mockSheet.snaps += 1;
        },
        forceClose: () => {
          mockSheet.forced = true;
        },
        close: () => {},
      }));
      ReactLib.useEffect(
        () => () => {
          mockSheet.props = null;
          mockSheet.forced = false;
        },
        []
      );
      return null;
    }
  );
  return { __esModule: true, default: Sheet };
});

jest.mock('@gorhom/bottom-sheet/lib/commonjs/hooks', () => ({
  useBottomSheetModalInternal: () => ({
    hostName: undefined,
    containerLayoutState: undefined,
    mountSheet: () => {},
    unmountSheet: () => {},
    willUnmountSheet: () => {},
  }),
}));

jest.mock('@gorhom/bottom-sheet/lib/commonjs/utilities', () => ({
  print: () => {},
}));

// The modal gates its content through the portal's mount/update callbacks
// (handlePortalRender refuses while DISMISSING). Render children only once a
// callback has let them through, as the real host would.
jest.mock('@gorhom/portal', () => {
  const ReactLib = jest.requireActual('react');
  function Portal({
    children,
    handleOnMount,
    handleOnUpdate,
    handleOnUnmount,
  }: {
    children: React.ReactNode;
    handleOnMount: (render: () => void) => void;
    handleOnUpdate: (render: () => void) => void;
    handleOnUnmount: (unmount: () => void) => void;
  }) {
    const [shown, setShown] = ReactLib.useState(false);
    const mounted = ReactLib.useRef(false);
    ReactLib.useEffect(() => {
      if (!mounted.current) {
        mounted.current = true;
        handleOnMount(() => setShown(true));
      } else {
        handleOnUpdate(() => setShown(true));
      }
    });
    ReactLib.useEffect(() => () => handleOnUnmount(() => {}), []);
    return shown ? children : null;
  }
  return { Portal, usePortal: () => ({ removePortal: () => {} }) };
});

const { default: BottomSheetModal } = jest.requireActual(
  '@gorhom/bottom-sheet/lib/commonjs/components/bottomSheetModal/BottomSheetModal'
) as { default: React.ComponentType<Record<string, unknown>> };

let frames: (() => void)[] = [];
let realRaf: typeof requestAnimationFrame;

beforeEach(() => {
  mockSheet.props = null;
  mockSheet.forced = false;
  mockSheet.snaps = 0;
  frames = [];
  realRaf = global.requestAnimationFrame;
  global.requestAnimationFrame = ((cb: () => void) => {
    frames.push(cb);
    return frames.length;
  }) as unknown as typeof requestAnimationFrame;
});

afterEach(() => {
  global.requestAnimationFrame = realRaf;
});

type Controls = { setVisible: (v: boolean) => void; visible: () => boolean };

const Host = forwardRef<Controls, { guarded: boolean; mirror: boolean }>(
  function Host({ guarded, mirror }, ref) {
    const [visible, setVisible] = useState(false);
    useImperativeHandle(ref, () => ({ setVisible, visible: () => visible }));
    const sheetRef = useRef<BottomSheetModalType>(null);
    const sync = useBottomSheetModalVisibility(sheetRef, guarded && visible);
    // The pre-TASK-432 wrapper, for the negative control.
    React.useEffect(() => {
      if (guarded) return;
      if (visible) sheetRef.current?.present();
      else sheetRef.current?.dismiss();
    }, [guarded, visible]);
    return (
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={['85%']}
        onAnimate={guarded ? sync.onAnimate : undefined}
        onDismiss={guarded ? sync.onDismiss : undefined}
        onChange={(index: number) => {
          if (guarded) sync.onChange(index);
          if (mirror && index === -1) setVisible(false);
        }}
      />
    );
  }
);

async function setup(guarded = true, mirror = true) {
  const ref = React.createRef<Controls>();
  await render(<Host ref={ref} guarded={guarded} mirror={mirror} />);
  return {
    show: (v: boolean) => act(async () => ref.current!.setVisible(v)),
    visible: () => ref.current!.visible(),
    frame: () =>
      act(async () => {
        frames.splice(0).forEach((f) => f());
      }),
    startOpen: () =>
      act(async () => {
        const p = mockSheet.props!;
        p.onAnimate(-1, p.index, 0, 0);
      }),
    settle: () =>
      act(async () => {
        mockSheet.props!.onChange(mockSheet.props!.index, 0, 0);
      }),
    finishClose: () =>
      act(async () => {
        const p = mockSheet.props!;
        p.onChange(-1, 0, 0);
        p.onClose();
      }),
    /** Open fully: present frame, open animation starts and lands. */
    async open() {
      await this.show(true);
      await this.frame();
      expect(mockSheet.props).not.toBeNull();
      await this.startOpen();
      await this.settle();
    },
  };
}

describe('useBottomSheetModalVisibility (real BottomSheetModal 5.2.14)', () => {
  it('negative control: the unguarded effect never opens a sheet mounted hidden', async () => {
    const s = await setup(false);
    await s.show(true);
    await s.frame();
    expect(mockSheet.props).toBeNull();
  });

  it('opens a sheet that mounted hidden', async () => {
    const s = await setup();
    await s.show(true);
    await s.frame();
    expect(mockSheet.props).not.toBeNull();
  });

  it('reopens after a close-button close (forced dismiss runs to completion)', async () => {
    const s = await setup();
    await s.open();
    await s.show(false);
    expect(mockSheet.forced).toBe(true);
    await s.finishClose();
    expect(mockSheet.props).toBeNull();

    await s.open();
  });

  it('reopens after a pan-down/backdrop close the library performs itself', async () => {
    const s = await setup();
    await s.open();
    // No dismiss(): the sheet animates closed on its own.
    await s.finishClose();
    expect(s.visible()).toBe(false);
    expect(mockSheet.props).toBeNull();

    await s.open();
  });

  it('a hide before the present frame (Codex #1) does not wedge the sheet', async () => {
    const s = await setup();
    await s.show(true);
    await s.show(false); // e.g. Android Back right after the tap
    await s.frame();
    // The held hide lands once the sheet has started animating.
    await s.startOpen();
    expect(mockSheet.forced).toBe(true);
    await s.finishClose();
    expect(mockSheet.props).toBeNull();

    await s.open();
  });

  it('a reopen during a forced close is held, not dropped into the close (Codex #2)', async () => {
    const s = await setup();
    await s.open();
    await s.show(false);
    await s.show(true);
    await s.frame();
    expect(mockSheet.snaps).toBe(0); // nothing fired into the closing sheet
    await s.finishClose();
    // The wrapper mirrors the old close into isVisible=false; the sheet must
    // end closed and still be openable.
    expect(s.visible()).toBe(false);
    await s.frame();
    expect(mockSheet.props).toBeNull();

    await s.open();
  });

  it('a close landing before a held reopen never leaves the sheet open while hidden (Codex #3)', async () => {
    const s = await setup();
    await s.open();
    await s.show(false);
    await s.show(true);
    await s.finishClose(); // onChange(-1) mirrors false; onDismiss fires
    await s.frame();
    // No present() slips out after the close: nothing mounts while hidden.
    expect(s.visible()).toBe(false);
    expect(mockSheet.props).toBeNull();

    await s.open();
  });

  it('a show held through a close is applied once the close lands, if the parent still wants it', async () => {
    const s = await setup(true, false); // parent ignores onChange(-1)
    await s.open();
    await s.show(false);
    await s.show(true);
    await s.finishClose();
    expect(s.visible()).toBe(true);
    await s.frame();
    expect(mockSheet.props).not.toBeNull();
  });
});
