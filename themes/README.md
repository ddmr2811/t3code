# Fork themes

## T3 Clawd Fork

`t3-clawd-fork.json` is [T3 Clawd](https://github.com/rohit3a/t3-clawd) adjusted for this fork's sidebar:

- The sidebar keeps the fork's attention order. Clawd moved the Working shelf above the threads that wait on you and added a "Recents" label.
- The machine pill next to the T3 Code logo stays visible.
- Collapsed shelves behave as in the app. They still show the open thread.
- Subagents under a row, and the Pinned and Work completed shelves, follow Clawd's look.
- The New chat badge reads "Ctrl N". Clients drop CSS values that contain a backslash, so the original's escaped ⌘ never showed.

To install it, open **Settings → Appearance → Add a theme** and drop the file in. From a shell, run `t3 theme set themes/t3-clawd-fork.json`.

The theme styles the app through its internal attributes, so an upstream update can break part of it.

### License

T3 Clawd is MIT licensed:

```
MIT License

Copyright (c) 2026 rohit3a

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
