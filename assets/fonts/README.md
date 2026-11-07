# Fonts

The app's fonts, as fixed-weight TTF files: iced can't read WOFF2, and it
picks weights by file. Each variable font was saved at the weights the app
uses with fontTools (`varLib.instancer`); nothing else was changed.

| Files | Font | Licence |
|---|---|---|
| `Inter-Regular/Medium/SemiBold/Bold.ttf` | Inter (Latin subset) at 400/500/600/700 | SIL Open Font License 1.1 |
| `JetBrainsMono-Regular.ttf` | JetBrains Mono (Latin subset) at 400 | SIL Open Font License 1.1 |
| `MaterialSymbolsOutlined-Regular.ttf` | Material Symbols Outlined (subset of the icons the app uses), FILL 0, weight 400, GRAD 0, opsz 24 | Apache License 2.0 |

To make a weight from a variable font (fontTools needs `brotli` for WOFF2):

```python
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

f = TTFont("inter-latin.woff2")
f.flavor = None
g = instantiateVariableFont(f, {"wght": 600}, updateFontNames=False)
g["OS/2"].usWeightClass = 600
g.save("assets/fonts/Inter-SemiBold.ttf")
```
