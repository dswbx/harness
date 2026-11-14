//! Pure geometry of the overlay window: frames, placement, growth. No Tauri, no state.

use super::Anchor;

/// A screen area or window frame, in one unit (physical px here).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The point of `frame` that `anchor` keeps in place: its top or bottom center.
pub fn anchor_point(frame: Rect, anchor: Anchor) -> (f64, f64) {
    let x = frame.x + frame.w / 2.0;
    match anchor {
        Anchor::Top => (x, frame.y),
        Anchor::Bottom => (x, frame.y + frame.h),
    }
}

/// Top-left of a `size` window whose top (or bottom) center is at `point`, moved so it is inside
/// `screen` with `margin` around it. A window larger than the screen keeps to its top-left.
pub fn place(point: (f64, f64), anchor: Anchor, size: (f64, f64), screen: Rect, margin: f64) -> (f64, f64) {
    let (w, h) = size;
    let top = match anchor {
        Anchor::Top => point.1,
        Anchor::Bottom => point.1 - h,
    };
    let x = (point.0 - w / 2.0).min(screen.x + screen.w - margin - w).max(screen.x + margin);
    let y = top.min(screen.y + screen.h - margin - h).max(screen.y + margin);
    (x, y)
}

/// `frame` grown by `room` to the right and down, but not past `screen`. The top-left stays, so
/// the page's card does not move and the page needs no offset.
pub fn grow(frame: Rect, room: f64, screen: Rect) -> Rect {
    let side = |space: f64| room.min(space).max(0.0);
    let right = side(screen.x + screen.w - frame.x - frame.w);
    let down = side(screen.y + screen.h - frame.y - frame.h);
    Rect { w: frame.w + right, h: frame.h + down, ..frame }
}

/// `frame` at `size`, grown from the corner the user drags: `left` / `top` move that edge and keep
/// the opposite one, else the left / top edge stays. Not smaller than `min`, not past `screen` less
/// `margin` (the minimum wins on a tiny screen).
pub fn sized(frame: Rect, size: (f64, f64), min: (f64, f64), screen: Rect, margin: f64, left: bool, top: bool) -> Rect {
    // One axis: the frame's start and length, the length asked, its minimum, the screen's start and length.
    let axis = |pos: f64, len: f64, want: f64, min: f64, s: f64, sl: f64, from_start: bool| {
        if from_start {
            let end = pos + len;
            let l = want.min(end - s - margin).max(min);
            (end - l, l)
        } else {
            (pos, want.min(s + sl - margin - pos).max(min))
        }
    };
    let (x, w) = axis(frame.x, frame.w, size.0, min.0, screen.x, screen.w, left);
    let (y, h) = axis(frame.y, frame.h, size.1, min.1, screen.y, screen.h, top);
    Rect { x, y, w, h }
}

/// The window frame for a card frame with `left` and `right` of side panels beside it.
pub fn beside(card: Rect, left: f64, right: f64) -> Rect {
    Rect { x: card.x - left, w: card.w + left + right, ..card }
}

/// The card frame inside a window frame that has `left` and `right` of side panels (`beside` undone).
pub fn card_of(window: Rect, left: f64, right: f64) -> Rect {
    Rect { x: window.x + left, w: window.w - left - right, ..window }
}

/// The window for a card with side panels: it grows left and right of the card, so the card stays
/// where it is. With no room on one side the whole window moves to stay inside `screen` less
/// `margin` (the card moves with it). A window wider than the screen keeps to the screen's left
/// edge; its width is never cut, so `card_of` stays exact.
pub fn widen(card: Rect, left: f64, right: f64, screen: Rect, margin: f64) -> Rect {
    let f = beside(card, left, right);
    let x = f.x.min(screen.x + screen.w - margin - f.w).max(screen.x + margin);
    Rect { x, ..f }
}

/// `r` (physical px, top-left origin) as an AppKit frame: points, origin at the bottom-left of the main
/// screen (`main_h` points high), y up. The same conversion tao makes for `set_position`.
pub fn cocoa_frame(r: Rect, scale: f64, main_h: f64) -> Rect {
    let (x, y, w, h) = (r.x / scale, r.y / scale, r.w / scale, r.h / scale);
    Rect { x, y: main_h - y - h, w, h }
}

#[cfg(test)]
mod tests {
    use super::{Rect, anchor_point, beside, card_of, cocoa_frame, grow, place, sized, widen};
    use crate::overlay::Anchor;

    const SCREEN: Rect = Rect { x: 0.0, y: 25.0, w: 1440.0, h: 875.0 };

    #[test]
    fn top_anchor_opens_below_the_point_centered() {
        assert_eq!(place((720.0, 300.0), Anchor::Top, (480.0, 300.0), SCREEN, 8.0), (480.0, 300.0));
    }

    #[test]
    fn bottom_anchor_centers_the_bottom_edge_on_the_point() {
        assert_eq!(place((720.0, 600.0), Anchor::Bottom, (480.0, 300.0), SCREEN, 8.0), (480.0, 300.0));
    }

    #[test]
    fn clamps_to_the_left_and_right_edges() {
        assert_eq!(place((10.0, 300.0), Anchor::Top, (480.0, 300.0), SCREEN, 8.0).0, 8.0);
        assert_eq!(place((1430.0, 300.0), Anchor::Top, (480.0, 300.0), SCREEN, 8.0).0, 1440.0 - 8.0 - 480.0);
    }

    #[test]
    fn no_room_below_the_mouse_moves_it_up() {
        assert_eq!(place((720.0, 850.0), Anchor::Top, (480.0, 300.0), SCREEN, 8.0).1, 25.0 + 875.0 - 8.0 - 300.0);
    }

    #[test]
    fn clamps_to_the_top_and_bottom_edges() {
        // Below the screen (bottom anchor near the Dock): moves up.
        assert_eq!(place((720.0, 990.0), Anchor::Bottom, (480.0, 300.0), SCREEN, 8.0).1, 25.0 + 875.0 - 8.0 - 300.0);
        // Above the screen (mouse at the menu bar, card edge above it): moves down under the work area's top.
        assert_eq!(place((720.0, 10.0), Anchor::Top, (480.0, 300.0), SCREEN, 8.0).1, 25.0 + 8.0);
    }

    #[test]
    fn a_window_larger_than_the_screen_keeps_to_its_top_left() {
        let small = Rect { x: 100.0, y: 50.0, w: 300.0, h: 200.0 };
        assert_eq!(place((250.0, 60.0), Anchor::Top, (480.0, 580.0), small, 8.0), (108.0, 58.0));
    }

    #[test]
    fn works_on_a_second_screen_left_of_the_main_one() {
        let left = Rect { x: -1920.0, y: 0.0, w: 1920.0, h: 1080.0 };
        assert_eq!(place((-1900.0, 200.0), Anchor::Top, (480.0, 300.0), left, 8.0), (-1912.0, 200.0));
    }

    #[test]
    fn resize_keeps_the_anchored_edge() {
        let prompt = Rect { x: 480.0, y: 300.0, w: 480.0, h: 300.0 };
        let top = anchor_point(prompt, Anchor::Top);
        assert_eq!(top, (720.0, 300.0));
        // The chat grows down from the same top center.
        assert_eq!(place(top, Anchor::Top, (580.0, 500.0), SCREEN, 8.0), (430.0, 300.0));
        let bottom = anchor_point(prompt, Anchor::Bottom);
        assert_eq!(place(bottom, Anchor::Bottom, (580.0, 500.0), SCREEN, 8.0), (430.0, 100.0));
    }

    #[test]
    fn grow_adds_room_right_and_down_only() {
        let card = Rect { x: 500.0, y: 400.0, w: 400.0, h: 200.0 };
        assert_eq!(grow(card, 100.0, SCREEN), Rect { x: 500.0, y: 400.0, w: 500.0, h: 300.0 });
    }

    #[test]
    fn grow_stops_at_the_screen_edges() {
        // Near the bottom-right corner: little room right and down, Radix flips or shifts the menus.
        let card = Rect { x: 1000.0, y: 620.0, w: 400.0, h: 200.0 };
        assert_eq!(grow(card, 100.0, SCREEN), Rect { x: 1000.0, y: 620.0, w: 440.0, h: 280.0 });
        // A frame already past the edge gets no room there (never smaller).
        let off = Rect { x: 1100.0, y: 400.0, w: 400.0, h: 200.0 };
        assert_eq!(grow(off, 100.0, SCREEN).w, 400.0);
    }

    #[test]
    fn sized_keeps_the_top_left_and_clamps() {
        let chat = Rect { x: 500.0, y: 100.0, w: 580.0, h: 600.0 };
        let min = (420.0, 340.0);
        // Free: the asked size, top-left kept.
        assert_eq!(sized(chat, (700.0, 650.0), min, SCREEN, 8.0, false, false), Rect { x: 500.0, y: 100.0, w: 700.0, h: 650.0 });
        // Not smaller than the minimum.
        assert_eq!(sized(chat, (100.0, 100.0), min, SCREEN, 8.0, false, false), Rect { w: 420.0, h: 340.0, ..chat });
        // Not past the screen less the margin.
        assert_eq!(sized(chat, (5000.0, 5000.0), min, SCREEN, 8.0, false, false), Rect { w: 1440.0 - 8.0 - 500.0, h: 900.0 - 8.0 - 100.0, ..chat });
    }

    #[test]
    fn sized_from_a_left_or_top_corner_keeps_the_opposite_edges() {
        let chat = Rect { x: 500.0, y: 100.0, w: 580.0, h: 600.0 };
        let min = (420.0, 340.0);
        let s = |size, left, top| sized(chat, size, min, SCREEN, 8.0, left, top);
        // Top-left: the bottom-right stays.
        assert_eq!(s((700.0, 650.0), true, true), Rect { x: 380.0, y: 50.0, w: 700.0, h: 650.0 });
        assert_eq!(s((100.0, 100.0), true, true), Rect { x: 660.0, y: 360.0, w: 420.0, h: 340.0 });
        assert_eq!(s((5000.0, 5000.0), true, true), Rect { x: 8.0, y: 33.0, w: 1072.0, h: 667.0 });
        // Top-right and bottom-left: one axis each way.
        assert_eq!(s((700.0, 650.0), false, true), Rect { x: 500.0, y: 50.0, w: 700.0, h: 650.0 });
        assert_eq!(s((700.0, 650.0), true, false), Rect { x: 380.0, y: 100.0, w: 700.0, h: 650.0 });
    }

    #[test]
    fn beside_and_card_of_undo_each_other() {
        let card = Rect { x: 500.0, y: 100.0, w: 580.0, h: 600.0 };
        let window = beside(card, 300.0, 420.0);
        assert_eq!(window, Rect { x: 200.0, y: 100.0, w: 1300.0, h: 600.0 });
        assert_eq!(card_of(window, 300.0, 420.0), card);
    }

    #[test]
    fn widen_keeps_the_card_in_place_when_there_is_room() {
        let card = Rect { x: 400.0, y: 100.0, w: 580.0, h: 600.0 };
        // Right panels grow the window to the right only, left ones to the left only.
        assert_eq!(widen(card, 0.0, 420.0, SCREEN, 8.0), Rect { w: 1000.0, ..card });
        assert_eq!(widen(card, 320.0, 0.0, SCREEN, 8.0), Rect { x: 80.0, w: 900.0, ..card });
    }

    #[test]
    fn widen_moves_the_window_when_a_side_has_no_room() {
        // Near the right edge: the window moves left, the card with it.
        let card = Rect { x: 800.0, y: 100.0, w: 580.0, h: 600.0 };
        let w = widen(card, 0.0, 420.0, SCREEN, 8.0);
        assert_eq!(w.x + w.w, 1440.0 - 8.0);
        assert_eq!(w.w, 1000.0);
        assert_eq!(card_of(w, 0.0, 420.0).x, 1440.0 - 8.0 - 1000.0);
        // Near the left edge: it moves right.
        let card = Rect { x: 50.0, ..card };
        assert_eq!(widen(card, 320.0, 0.0, SCREEN, 8.0).x, 8.0);
    }

    #[test]
    fn widen_wider_than_the_screen_keeps_its_width_at_the_left_edge() {
        let card = Rect { x: 400.0, y: 100.0, w: 580.0, h: 600.0 };
        let w = widen(card, 500.0, 500.0, SCREEN, 8.0);
        assert_eq!((w.x, w.w), (8.0, 1580.0));
    }

    #[test]
    fn cocoa_frame_flips_y_and_converts_to_points() {
        // A 2x screen 900 points high: a window 100 points from the top, 300 points high.
        let r = Rect { x: 200.0, y: 200.0, w: 1000.0, h: 600.0 };
        assert_eq!(cocoa_frame(r, 2.0, 900.0), Rect { x: 100.0, y: 900.0 - 100.0 - 300.0, w: 500.0, h: 300.0 });
        // Growing to the left keeps the right edge and the bottom: one frame, both changes.
        let grown = Rect { x: 0.0, w: 1200.0, ..r };
        let (a, b) = (cocoa_frame(r, 2.0, 900.0), cocoa_frame(grown, 2.0, 900.0));
        assert_eq!((a.x + a.w, a.y), (b.x + b.w, b.y));
    }

    #[test]
    fn closing_panels_shrinks_back_around_the_same_card() {
        let card = Rect { x: 400.0, y: 100.0, w: 580.0, h: 600.0 };
        let open = widen(card, 320.0, 420.0, SCREEN, 8.0);
        let back = widen(card_of(open, 320.0, 420.0), 0.0, 0.0, SCREEN, 8.0);
        assert_eq!(back, card);
    }
}
