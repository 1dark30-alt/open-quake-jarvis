# Dashboard UI Design System

## Philosophy

The device should feel like a **purpose-built appliance**, not a desktop
application squeezed onto a small screen.

### Design priorities

1.  Readability at arm's length
2.  Fast touch interaction
3.  Minimal cognitive load
4.  Consistent behavior across every screen
5.  Calm, information-first appearance

Every page should answer three questions in under one second:

-   Where am I?
-   What's happening?
-   What can I do?

------------------------------------------------------------------------

# Layout

## Three-column philosophy

Whenever possible:

``` text
Context | Primary Content | Secondary Content
```

Examples:

``` text
Album Art | Player | Lyrics
Meeting App | Controls | Volume
Weather | Current | Forecast
Camera | Feed | Detection List
```

Not every screen needs all three columns, but pages should follow the
same mental model.

## Use a grid

Nothing should "float."

Every element aligns to invisible columns and rows.

``` text
│ Album │ Title
│       │ Artist
│       │ Progress
│       │ Controls
```

## Spacing

Use a consistent spacing scale.

-   8 px
-   16 px
-   24 px
-   32 px
-   48 px
-   64 px

Never invent a spacing value.

------------------------------------------------------------------------

# Visual Hierarchy

Every screen should have one obvious focal point.

Examples:

-   Media → Song title
-   Calendar → Current meeting
-   Camera → Live image
-   Home → Current room

Everything else supports that focal point.

------------------------------------------------------------------------

# Information Hierarchy

## Primary

Largest element on the page.

Examples:

-   Lost Boys
-   Kitchen Lights
-   Front Door
-   Meeting with Bob

## Secondary

Supporting information.

Examples:

-   Paper Bird
-   Kitchen
-   Camera 3
-   2:00 PM

## Tertiary

Status.

Examples:

-   Playing
-   Connected
-   Recording
-   Online

## Quaternary

Diagnostic information.

Examples:

-   Chrome
-   Wi-Fi
-   Bluetooth
-   192.168.1.42

This information should never compete with primary content.

------------------------------------------------------------------------

# Cards

Cards create organization, not decoration.

Use cards only for:

-   Artwork
-   Camera feeds
-   Control groups
-   Scrollable regions
-   Optional panels

Do **not** put every label inside a card.

------------------------------------------------------------------------

# Controls

Controls that belong together should look together.

Good:

``` text
┌────────────────────┐
◀   ▶   ⏸
└────────────────────┘
```

Bad:

``` text
◀

▶

⏸
```

------------------------------------------------------------------------

# Buttons

Every button has one purpose.

Maintain consistent:

-   Corner radius
-   Shadow
-   Icon size
-   Touch target

Recommended minimum touch target:

-   48 × 48 px

Primary actions should always be visually dominant.

------------------------------------------------------------------------

# Colors

Reserve color for meaning.

  Meaning          Color
  ---------------- --------------
  Primary Action   Accent
  Success          Green
  Warning          Yellow
  Error            Red
  Disabled         Gray
  Background       Dark Neutral

Avoid using bright colors simply because something is clickable.

------------------------------------------------------------------------

# Typography

Use a consistent hierarchy.

    Level Purpose
  ------- ----------
    36 px Title
    22 px Subtitle
    16 px Body
    13 px Status
    11 px Metadata

Hierarchy should come from size and weight before color.

------------------------------------------------------------------------

# Icons

-   Use a single icon family.
-   Do not mix icon styles.
-   Icons should be immediately recognizable.
-   Avoid icons that require explanation.

------------------------------------------------------------------------

# Empty States

Never leave blank space without purpose.

Good:

``` text
Nothing Playing

Select a music source
```

Bad:

``` text
Nothing Playing

-

-

-
```

------------------------------------------------------------------------

# Progressive Disclosure

Show only what is needed.

Instead of:

``` text
Song
Artist
Album
Codec
Bitrate
Source
Output
Device
```

Prefer:

``` text
Song
Artist
```

Reveal additional information only when requested.

------------------------------------------------------------------------

# Animation

Animation should communicate.

Good:

-   Album art fades
-   Page slides
-   Progress moves
-   Buttons gently highlight

Avoid:

-   Bouncing
-   Flashing
-   Spinning
-   Excessive glow

Target animation duration: **150--250 ms**.

------------------------------------------------------------------------

# Scrolling

-   Scroll only the region that needs scrolling.
-   Scrollbars should be subtle.
-   Never scroll the entire page unless absolutely necessary.

------------------------------------------------------------------------

# Consistency

If one screen uses:

``` text
Artwork
Title
Subtitle
Controls
```

Similar screens should follow the same order.

Users should be able to predict where information lives.

------------------------------------------------------------------------

# Responsive Behavior

Adapt the layout as content changes.

Examples:

No lyrics:

``` text
Album | Player
```

No artwork:

``` text
Player expands
```

No progress:

``` text
Controls move upward
```

Avoid leaving permanent empty regions.

------------------------------------------------------------------------

# Design Language

The application should consistently feel:

-   Calm rather than flashy
-   Intentional rather than decorative
-   Appliance-like rather than desktop-like
-   Information-first rather than control-first
-   Spacious rather than crowded
-   Predictable rather than surprising

------------------------------------------------------------------------

# Design Checklist

Before adding any element, ask:

1.  Does this help the user accomplish the primary task?
2.  Can it be combined with an existing element?
3.  Does it follow an existing design pattern?
4.  Would the user miss it if it were removed?
5.  Is it visually competing with something more important?

------------------------------------------------------------------------

# State Consistency

Each page should feel like the same page in every state:

-   Idle
-   Active
-   Loading
-   Error

Keep the layout stable. Change the content within established regions
rather than moving controls around.
