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

Models: Gemini `gemini-3.5-flash-lite` (translation), `gemini-3.8-flash` (dictation); Anthropic `claude-haiku-5-5` (translation); OpenAI `gpt-4.1-mini` (translation/dictation cleanup), `gpt-4o-mini-tts` (speech), `gpt-transcribe` (dictation).

Voice evidence: [Google Chirp 3 HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd), [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech), [OpenAI CLI speech example](https://developers.openai.com/api/reference/cli/resources/audio/subresources/speech/methods/create).
