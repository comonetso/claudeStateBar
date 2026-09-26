import sys, json, base64, io
from PIL import Image
# 사용: crop.py 출력파일 → 각 그룹 캡처에서 iframe 영역을 잘라 저장
out = sys.argv[1]; shots = {}; meta = None
for line in open(out, encoding='utf-8', errors='replace'):
    if line.startswith('@@RVSHOT_'):
        k, b = line.split(' ', 1); shots[k[9:]] = Image.open(io.BytesIO(base64.b64decode(b.strip()))).convert('RGB')
    elif line.startswith('@@RV '):
        meta = json.loads(line.split(' ', 1)[1])
for g, im in shots.items():
    s = im.size[0] / 1440.0
    for w, b in meta['boxes' + g].items():
        c = im.crop((round(b['x']*s), round(b['y']*s), round((b['x']+b['width'])*s), round((b['y']+b['height'])*s)))
        c.save('rv_%s.jpg' % w); print('rv', w, c.size)
