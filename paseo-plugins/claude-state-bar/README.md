# Speech providers

The **TTS, STT, Translation Provider** section in Claude State Bar settings selects a language and a separate API provider for each feature.

| Feature | Providers | Default |
| --- | --- | --- |
| Translation | Google (Gemini), OpenAI (ChatGPT), Anthropic (Claude) | Google |
| Read aloud | Google, OpenAI | Google, Zephyr |
| Dictation | Google, OpenAI | Google |

The shared language choices, in order, are Korean, English, Japanese, Chinese, Spanish, French and Arabic. Before settings are saved, the language follows Paseo's Korean/English screen language, falling back to Korean.

Expand the selected voice to see the available choices. Select a name to choose it and close the list. Preview plays a fixed sentence in the selected language without changing the selected voice; press again to stop. Preview audio is reused for that provider, voice and language while the settings screen remains open, including while the section is collapsed. The sound is AI-generated.

Each provider lists six widely used female voices: Google **Zephyr, Aoede, Callirrhoe, Despina, Kore, Leda** (gender as reported by Google); OpenAI **marin, alloy, coral, nova, sage, shimmer** (OpenAI does not publish voice genders, so these are the voices commonly described as female). A previously saved supported voice outside these lists appears first and stays selected.

Press **Save provider settings** to apply language, provider and voice changes. Settings live in `~/.paseo/claude-state-bar/speech.json` (under `PASEO_HOME` when set). Saving on the PC sends the same settings to the servers used for dictation name hints and shows each server's result. Server chats use their own daemon's settings and API keys.

Only the selected providers' required key fields are shown. **Save keys** updates non-empty fields in that device's existing `google.env`; saved values are never returned to the screen. Google uses `GOOGLE_GEMINI_KEY` for translation/dictation and `GOOGLE_TTS_KEY` for speech; OpenAI uses `OPENAI_API_KEY`; Anthropic uses `ANTHROPIC_API_KEY`. Key checks make short translation/synthesis requests and show each key's result. They do not test the microphone or dictation endpoint.

Translation storage is separate for each provider and language. Existing entries without a provider are read as Google entries, retaining their original seven-day expiry. A missing key or a failed request returns an error without changing providers.

**Translate thinking automatically** (off by default) shows thinking boxes translated from the start, without pressing Translate. Only paragraphs not already in the chosen language are translated, and the original shows briefly until the translation arrives. While it is on, each box keeps only the Original and Read buttons, and Read waits for the translation before reading it. When it is off, the buttons go back to Translate, Read and Translate and read; Translate and read shows the translation only while reading and returns to the previous view when it finishes. Chats running on a server are translated with that server's key file. A collapsed box sends nothing to translate and is translated the moment it is expanded, whether it was collapsed with Collapse all above the input or on its own. Translations already requested are still kept, and a collapsed box that is being read aloud keeps translating. Right below it, **Expand thinking automatically** (on by default) opens the box that is still thinking and lifts its height limit while automatic translation is on, so it shows without scrolling.

Models: Gemini `gemini-3.5-flash-lite` (translation), `gemini-3.8-flash` (dictation); Anthropic `claude-haiku-5-5` (translation); OpenAI `gpt-4.1-mini` (translation/dictation cleanup), `gpt-4o-mini-tts` (speech), `gpt-transcribe` (dictation).

Voice evidence: [Google Chirp 3 HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd), [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech), [OpenAI CLI speech example](https://developers.openai.com/api/reference/cli/resources/audio/subresources/speech/methods/create).

## When the PC is offline

When the PC disconnects, Calladmin-Gabia provides the project list and manager, usage, settings screen and dictation input protection. The PC takes over again when it reconnects; each screen has one set of these contributions. Other servers do not take over, and employee daemons keep their existing behavior.

The PC sends a separate project copy, including pins and category/project order, to the same servers as dictation name hints at daemon startup and whenever those files change. The copy is stored in `~/.paseo/claude-state-bar/pc-offline-projects.json`; it is separate from each server's own project file. Failed transfers are tried at the next change or daemon startup. The fallback server needs a successfully delivered copy.

While Calladmin-Gabia is providing these screens, projects and settings are read-only. Selecting a PC project shows an offline notice; connected server projects open normally. Usage and displayed settings come from Calladmin-Gabia. Saving settings, providers, keys, names, uploading sounds, and resetting or editing project order are disabled. Automatic alert sounds, settings synchronization, layout save/load, representative-device selection and pane-maximize logging remain PC features. Dictation protection retains its existing supported-app-version limit.

## Switching the Claude provider in the same chat

When a device's Paseo settings include the `claude-yeogiaen` provider, Claude chats on that device get a provider pill above the composer. The pill is an icon on every screen; it turns orange while the chat runs on a Claude provider other than the one it was opened with. Providers are shown by the device's Paseo provider names, such as Claude and Claude (Yeogiaen), in the tooltip and the confirmation. Pressing it asks for confirmation. Switching stops the chat's Claude process; the next message starts it again through the other provider and continues the same conversation, so earlier context and the on-screen history are kept. A reply in progress is cancelled, Paseo shows a "Claude stopped unexpectedly" error once (it reports every stop of an idle Claude process; the confirmation warns about it), and the first reply after the switch reads the whole conversation again against the limit of the new provider's account; the confirmation shows the current context size.

Paseo does not let a chat change its provider, so the provider recorded for the chat and the provider name at the top stay the same; only the account values used to start Claude change. The switch is recorded per device in `~/.paseo/plugin-data/claude-state-bar/accounts.json` (under `PASEO_HOME` when set) and removed when the chat is archived. The launchers `claude-rc-relay` and `claude-team-launch` read that record whenever they start Claude and stop Claude when the record for their chat changes. They change only the account values the `claude-yeogiaen` provider sets: `CLAUDE_CONFIG_DIR` on the PC and `CLAUDE_CODE_OAUTH_TOKEN` on the servers. A switch to `claude-yeogiaen` on the PC runs the team settings sync first. On a server, the `claude-yeogiaen` provider must start Claude through `claude-rc-relay` for its chats to switch to `claude`. Nothing switches automatically. Only the `claude` and `claude-yeogiaen` providers can be switched between; chats cannot move to Codex or other providers, and employee daemons do not show the pill.

## Logging in to Claude again

When the Claude login lapses and a chat stops with "Failed to authenticate" or "Not logged in", a red key pill appears above that chat's composer. Pressing it has that device's daemon run `claude auth login` and returns the approval link. Open the link in any browser, phone or PC, approve it, and paste the code shown after approval to finish. The stopped message is not resent; the chat continues when you send the next message. The **Claude login** section near the top of the settings screen lets you log in again on each device at any time, and it opens with the number of stopped chats when a login has lapsed.

The login targets are that device's Claude providers that use a login file; providers sharing the same login folder (`CLAUDE_CONFIG_DIR`) are grouped. Providers that set `CLAUDE_CODE_OAUTH_TOKEN` in their env are left out because logging in again cannot fix them. A chat switched to another provider logs in to that provider's login file. The error is recognised when a turn ends with that single error line as its last reply. The login command is kept from opening a browser by itself, so open the link with **Open link** on the screen. After logging in the daemon checks that the login file was written, and the approval link and code are never logged. Employee daemons do not have this.
