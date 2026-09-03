# Installation

For people who are not developers. You will need to use a terminal, but only to
copy and paste four lines.

## Before you start

You need two things:

1. **The Spotify desktop app.** Not the web player — Smart DJ cannot run there.
2. **Spicetify**, which is the tool that lets extensions run inside Spotify.
   Install it from [spicetify.app/docs/getting-started](https://spicetify.app/docs/getting-started)
   and follow their instructions for your operating system first.

Check Spicetify is working by opening a terminal and running:

```bash
spicetify -v
```

If that prints a version number, you are ready. If it says "command not found",
Spicetify is not installed or not on your PATH — go back to their guide.

You also need [Node.js](https://nodejs.org) (any recent version) to build the
extension.

## Install

Open a terminal and run these four lines, one at a time:

```bash
git clone https://github.com/guilhepinheiro1701-create/spicetify-automix.git
cd spicetify-automix
npm install
npm run install:spicetify
```

The last line builds the extension, copies it into Spicetify's folder,
registers it, and restarts Spotify. It tells you what it is doing at each step.

When it finishes, look at the bottom-right of the Spotify player bar. There is a
new **Smart DJ** button. Click it to open the panel.

### What the installer touches

It writes exactly one file — `smart-dj.js` in your Spicetify Extensions folder —
and adds one entry to your Spicetify configuration. It does not modify Spotify
directly, does not touch any other extension, and does not change any of your
existing settings.

## Manual install

If you would rather do it yourself, or the installer could not find your
Spicetify folder:

```bash
npm install
npm run build
```

Then copy `dist/smart-dj.js` into your Extensions folder:

| System | Folder |
| --- | --- |
| **Windows** | `%appdata%\spicetify\Extensions\` |
| **macOS / Linux** | `~/.config/spicetify/Extensions/` |

Not sure where yours is? Ask Spicetify:

```bash
spicetify path userdata
```

Then register and apply:

```bash
spicetify config extensions smart-dj.js
spicetify apply
```

## Updating

```bash
cd spicetify-automix
git pull
npm install
npm run install:spicetify
```

## Uninstalling

```bash
spicetify config extensions smart-dj.js-
spicetify apply
```

The trailing `-` removes it. Then delete `smart-dj.js` from the Extensions
folder if you want it gone entirely.

Smart DJ restores your original crossfade setting when it shuts down, so nothing
is left behind in Spotify's own settings.

## First run

Open the **Smart DJ** panel and look at the **Compatibility** section. It tells
you what your client can actually do:

- **Full DJ mode** — your client allows real audio overlap between tracks.
- **Fade mode** — no overlap available (most likely a Free account on a recent
  build, where Spotify gates crossfade behind Premium). Smart DJ still times the
  switch musically, matches levels, and can skip dead intros. It just cannot
  play two tracks at once, and it will not pretend to.
- **Passive** — Smart DJ cannot affect playback on this client. Spotify behaves
  exactly as it would without it.

If something is not working, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
