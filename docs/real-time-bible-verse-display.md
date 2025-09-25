# Building Real-Time Bible Verse Display Software

## Introduction

Developing a system that can display Bible verses in real time during live preaching is a multifaceted engineering challenge. The workflow must combine live speech recognition, natural language parsing to detect Scripture references, rapid retrieval of verse text across multiple translations, and a seamless projection overlay that can operate even when no internet connection is available. Recent advances in AI and church technology (for example, apps such as Velora Bible) show that the idea is feasible—these tools listen to the sermon, detect when a verse is cited, and instantly show the relevant passage on screen. This document explores how to build a similar system and covers existing tools, recommended architecture, performance considerations, multi-translation support, UX design, and licensing issues.

## Speech Recognition for Live Sermons

Real-time speech-to-text (ASR) is the core enabling technology. The system must continuously listen to the sermon audio, identify when a Bible reference is spoken, and output text fast enough for projection.

### Offline Speech Recognition Engines

Offline (on-premise) ASR keeps the system running without internet access. A leading choice is the Vosk toolkit (built on Kaldi). Vosk provides streaming, low-latency transcription, supports 20+ languages and dialects, and allows developers to add custom vocabulary at runtime—perfect for Biblical names such as "Habakkuk" or "Philemon." Models are lightweight (around 50 MB) yet handle large-vocabulary speech with continuous transcription and minimal latency. OpenAI's Whisper (open source) is another offline option that achieves state-of-the-art accuracy (around 95% even with diverse accents and noisy audio). Whisper prioritizes accuracy over speed, so real-time operation can require a smaller model or a GPU, but it is very robust for sermons.

### Cloud-Based Speech Recognition Services

Cloud APIs (Google, Microsoft, Amazon, etc.) offer excellent accuracy and language coverage with high scalability. Google Speech-to-Text provides streaming transcription with helpful features such as phrase hints. Microsoft Azure Cognitive Services offers real-time transcription, optional customization, and containerized offline deployments for hybrid setups. The trade-offs are internet dependence, cost, and privacy. A network delay of even one or two seconds can be problematic during a service, so connection reliability must be considered.

### Recommended Approach

For maximum reliability and offline capability, an on-premise ASR engine is ideal. Vosk is a strong candidate thanks to its streaming API, low latency, and multi-language support. It also has bindings for Python, Java, C#, and JavaScript, so it fits many tech stacks and runs on modest hardware (even on a Raspberry Pi in lightweight scenarios). If higher accuracy is needed and sufficient compute is available, a hybrid approach can combine Vosk for immediate results with Whisper as a background verifier that refines longer quotations.

### Streaming & Latency

The ASR engine should process audio in streaming mode, outputting partial transcriptions as audio arrives. Vosk's streaming mode and voice-activity detection minimize delay. Batch-oriented models (such as Whisper without streaming support) process audio in chunks, which introduces additional latency. The system should wait until it hears the complete reference (book name, chapter, and verse numbers) before triggering the display to avoid false matches. Detecting patterns like `<Book> <Chapter> verse <Verse>` or `<Book> <Chapter>:<Verse>` in partial transcripts is effective.

### Accuracy Considerations

Sermons include unique proper names, diverse accents, and occasional background noise. Feeding the system directly from the pastor's microphone improves accuracy by reducing ambient sound. Loading the ASR model with custom vocabulary (all Bible book names plus common phrases such as "chapter" and "verse") further improves detection. Whisper's large training set offers robustness to accent and noise, while Vosk can be tuned with custom language models if necessary.

## Parsing and Identifying Bible References

After transcription, the system must detect Bible references in the text. Instead of implementing a parser from scratch, leverage existing open-source scripture parsing libraries:

- **OpenBible BCV Parser (JavaScript/TypeScript)** can identify and normalize citations like "John iii.16" or "Jn 3:16". It handles abbreviations, punctuation variations, and minor typos, producing standardized references in under a millisecond for short strings.
- **`pythonbible` Library** provides robust reference parsing and normalization in Python. It can extract verses from complex sentences, assigns unique IDs to each verse, and converts between reference strings and internal identifiers—ideal for database lookups.
- **Custom Regex or Grammar** is possible but error-prone. Maintaining the list of book name variants, punctuation rules, and range handling is tedious; existing parsers already capture these nuances (including pluralization of Psalms and the format of one-chapter books such as Jude).

Integration options include continuously scanning the ASR transcript buffer for valid references or parsing finalized sentences. Continuous scanning allows immediate detection but requires safeguards against false positives (e.g., verifying that chapter and verse numbers exist in the specified book).

In practice, you can load language-specific BCV lexicons to mirror the spoken language. Our implementation dynamically swaps between English, Spanish, Portuguese, and French parser bundles depending on the operator's microphone language, while falling back to English when a manual typed reference needs parsing. This keeps detections accurate for multilingual congregations without blocking volunteers who still type references in English.

## Retrieving Verse Text from the Bible

Once the software recognizes a reference (for example, John 3:16) it must fetch the corresponding verse text—ideally supporting multiple translations.

### Data Sources for Scripture Text

- **Local Bible Text Database:** Storing Bible text locally ensures offline availability and instant lookups. Public-domain translations (KJV, ASV, World English Bible, etc.) can be bundled. Libraries like `pythonbible` ship with KJV and ASV data and expose helpers such as `get_verse_text(verse_id, Version.KING_JAMES)`. Alternatively, a lightweight SQLite database can store verse text for each translation. The SWORD Project also provides a large collection of Bible modules and an API for accessing them (some free, others licensed).
- **Online Bible APIs:** Services like API.Bible (American Bible Society) or BibleGateway return verses in many versions. API.Bible exposes nearly 2,500 versions across 1,600+ languages via JSON, offers generous limits for non-commercial use, and encourages caching. Crossway's ESV API provides free access to ESV text for non-commercial apps with required attribution. Online APIs introduce latency (typically 100–300 ms), so caching or prefetching is important.

### Multi-Translation Support

Supporting multiple translations might mean bundling public-domain versions and letting users add others. Modern translations (NIV, ESV, etc.) are copyrighted, so the software can prompt users to supply licensed text files or API credentials. Presentation software like ProPresenter sells licenses for each translation (approximately $15 per version per computer), and a similar model can be adopted. At minimum, ship with one free version (e.g., KJV) as a fallback and display attribution strings when required.

### Licensing Considerations

- **Public Domain:** KJV, ASV, World English Bible, and Berean Study Bible (public-domain edition) can be bundled freely.
- **Licensed Translations:** NIV (Biblica/HarperCollins), ESV (Crossway), NASB, NKJV, etc., require permission. Some, such as the NET Bible, allow free non-commercial use with attribution. The software should clearly indicate which versions require a license and provide instructions to import legally acquired texts or configure API keys.
- **Attribution:** Many publishers mandate displaying the translation tag (e.g., "[ESV]") and a copyright notice in slides or supporting materials. Include configuration options to show translation tags next to each verse and display a consolidated copyright notice.

## System Architecture and Tech Stack

Design the system as modular components that handle audio input, recognition, parsing, and display:

1. **Audio Capture Module:** Interfaces with the sound system (e.g., via the PC sound card or digital mixer) to provide PCM audio to the recognizer. Use libraries like `pyaudio`/`sounddevice` (Python), NAudio (C#), or PortAudio (C++). Downsample or preprocess audio to match ASR requirements.
2. **Speech Recognition Engine:** Embed an offline engine (such as Vosk) in streaming mode. Run recognition in a separate thread/process and emit events when a complete reference is detected. Maintain a state machine that watches for book names followed by chapter and verse numbers. Optionally add Whisper as a background verifier.
3. **Reference Parsing & Handling:** Use a parser library to normalize references, perform verse lookups, and prevent duplicates. Cache recently displayed references to avoid repeated triggers and handle sequential verses gracefully.
4. **Verse Display Module (UI/Overlay):** Implement a clean overlay for projectors or live streams. Options include:
   - A standalone GUI (Qt, WPF) with a transparent or themed overlay.
   - Integration with OBS or presentation software via local text/HTML feeds.
   - A local web front end served by the app (for example, an Electron or Svelte UI) that updates content through websockets.

### Programming Language Considerations

- **Python** offers rapid development with existing libraries (Vosk bindings, `pythonbible`, etc.) and can be packaged with PyInstaller.
- **C# (.NET)** provides polished Windows UI capabilities (WPF/WinUI) and straightforward multithreading. Vosk has .NET bindings, and Azure SDKs integrate cleanly if cloud fallback is desired.
- **Node.js/TypeScript** enables Electron-based apps with web front ends and access to OpenBible's BCV parser through npm packages.
- **C++** maximizes performance but increases development complexity.

Choose the stack that matches the team's expertise; Python with Qt or C# with WPF are practical combinations for church IT teams.

## Real-Time Performance and Latency Challenges

Achieving sub-second latency requires careful tuning of each stage:

- **ASR Latency:** Streaming ASR (Vosk) outputs words almost instantly. If using chunked models, keep windows small (e.g., 5 seconds) and add silence detection. Only trigger on finalized words or high-confidence results to avoid false displays.
- **Parsing & Lookup:** Scripture parsing and local database lookups are fast (microseconds to milliseconds). Remote API calls can add hundreds of milliseconds; mitigate by caching, prefetching known passages, or bundling essential translations offline.
- **Display Latency:** UI updates are trivial, but ensure the overlay runs on a separate thread/event loop so it never blocks on recognition work. Target a total end-to-end delay under one second so the verse appears as the pastor begins reading.
- **Error Handling:** Detect invalid references (e.g., "Mark 16:50" which does not exist) and ignore them. Log recognized phrases and actions for debugging and iterative improvement. Consider context awareness (e.g., if the pastor says "verse 17" after John 3:16) while providing manual overrides to prevent incorrect assumptions.

## UX/UI Considerations for Seamless Overlays

- **Non-Distracting Presentation:** Use clear, high-contrast text on neutral or slightly transparent backgrounds. Subtle fade-in/out animations can make transitions smooth without distracting viewers.
- **Readable Typography:** Choose large font sizes (suitable for the room), with references (e.g., "John 3:16 [NIV]") shown near the verse. Break longer passages into multiple slides rather than shrinking text.
- **Display Timing:** Keep verses visible while the pastor discusses them. Provide configurable auto-hide timers and manual controls for operators to clear or persist verses.
- **Operator Override:** Offer a control panel that lists the last detected reference, allows manual confirmation/correction, toggles translations, and provides emergency hide/show actions.
- **Multi-Screen Support:** Support projecting to in-house displays and feeding overlays to live-streaming software (OBS, vMix, etc.).
- **Visual Consistency:** Allow customization (fonts, colors, logos) to match the church's branding. Provide optional confidence monitor output so the pastor can verify what the congregation sees.

## Legal and Licensing Considerations

- **Translation Licenses:** Include only public-domain texts by default. For modern translations, prompt users to confirm they hold licenses (or direct them to official licensing channels). Provide tooling to import user-supplied modules or API keys securely.
- **Display Permissions:** Many publishers permit churches to display limited verses during services, especially when the church owns copies. Encourage users to review publisher guidelines (e.g., Zondervan for NIV, Crossway for ESV) and include disclaimers that proper licensing is the user's responsibility.
- **Privacy:** Offline ASR avoids sending sermon audio to third parties. If cloud services are used for ASR or verse retrieval, obtain church consent and document privacy policies. Avoid storing full transcripts unless explicitly enabled; provide options to clear logs.
- **Open-Source Licenses:** Respect licenses of integrated libraries (Vosk: Apache 2.0, pythonbible: MIT, BCV parser: MIT). If incorporating GPL components (e.g., SWORD), ensure compatibility with the app's license or keep those components isolated.
- **Liability:** Provide disclaimers noting that occasional mis-recognitions may occur and that the pastor or operator should verify displayed content.

## Conclusion

Real-time Bible verse display during sermons is achievable with modern speech recognition and scripture parsing tools. By combining an offline ASR engine (such as Vosk or Whisper) with a robust Bible reference parser and local verse database, the system can recognize and show verses almost instantly. Key takeaways include:

- Leverage existing libraries to minimize development effort while maintaining high quality.
- Choose an architecture that prioritizes low latency, offline capability, and ease of maintenance.
- Support multiple translations responsibly, respecting licensing requirements.
- Deliver a distraction-free, reliable user experience that enhances worship rather than complicating it.

Such a system empowers congregations to engage with Scripture as it is preached, whether in person or online. With thoughtful engineering and licensing compliance, developers can create an edifying, modern tool that brings technology and tradition together.

## References and Resources

- Alpha Cephei. "Vosk Speech Recognition." https://alphacephei.com/vosk/
- OpenAI. "Whisper: Robust Speech Recognition via Large-Scale Weak Supervision." https://openai.com/research/whisper
- Tomedes. "Google Speech-to-Text vs. Whisper: Which Speech Recognition Tool Wins?" https://www.tomedes.com/translator-hub/google-speech-to-text-vs-whisper
- Reddit. "Velora Bible Uses AI to Display Verses in Real Time." https://www.reddit.com/r/churchtech/
- OpenBible.info. "Bible Parser (BCV)." https://github.com/openbibleinfo/Bible-Passage-Reference-Parser
- pythonbible. "Documentation." https://pythonbible.org/
- Renewed Vision. "Bible Licenses in ProPresenter." https://support.renewedvision.com/hc/en-us/articles/360043270093-Bible-licenses
- OpenLP Community Forum. "Bible Copyright Discussion." https://forums.openlp.org/
- Crossway. "ESV API." https://api.esv.org/
- American Bible Society. "API.Bible." https://scripture.api.bible/
- Sermon on the Mount App. "Mission Statement." https://sermononthemount.app/
