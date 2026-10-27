# Security

Pedal Thyme is a single HTML file that people download and open on their own computers, often
together with files other people have shared (schematics, pedalboards, LTspice files, PDFs). It's
built so that:
- It never connects to the network. A Content Security Policy blocks every connection.
- Files it opens are treated as untrusted. They're checked field by field, their text is escaped
  before it's shown, and PDFs are drawn without running any code they contain.

The [developer guide](docs/development.md#security-model) explains how.

## Reporting a vulnerability

If you find a way around any of this, please report it privately, not in a public issue: use
**Report a vulnerability** on the repository's [Security](../../security/advisories/new) tab. Include:
- The version (shown at the bottom of the page) and your browser.
- What happens, and the steps or file that make it happen.

I'll reply as soon as I'm able, fix it in a new release, and credit you in the release notes unless
you'd rather not be named.

## Supported versions

Only the latest release gets fixes. If you use an older version, update to the latest (see
[Updating](README.md#updating)).

## Checking a download

Each release lists the SHA-256 checksum of `pedal-thyme.html`. Compare it with your copy before
opening a file you got from somewhere other than this repository's
[Releases](../../releases) page (see [Checking a download](README.md#checking-a-download)).
