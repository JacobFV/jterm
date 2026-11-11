"""python3 sheet.py out.png t1 t2 ... — renders those seconds and tiles them 2 across."""
import subprocess, sys, os
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
out, times = sys.argv[1], [float(x) for x in sys.argv[2:]]
subprocess.run([sys.executable, os.path.join(here, "render.py"), "stills", *map(str, times)], check=True)
cols = 2; rows = (len(times) + 1) // 2
sheet = Image.new("RGB", (cols * 960, rows * 540))
for i, t in enumerate(times):
    im = Image.open(os.path.join(here, "stills", f"{t:07.3f}.png")).convert("RGB").resize((960, 540), Image.LANCZOS)
    sheet.paste(im, ((i % cols) * 960, (i // cols) * 540))
sheet.save(os.path.join(here, "stills", out))
