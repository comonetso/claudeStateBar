# Stitch manual tile captures: tile i goes at document y = scrollY_i × DPR (a later tile covers an earlier one)
import sys, json
from PIL import Image
def stitch(files, sys_list, dpr, doc_h_css, out, crop_w=None):
    tiles=[Image.open(f).convert('RGB') for f in files]
    W=tiles[0].size[0] if crop_w is None else crop_w
    H=round(doc_h_css*dpr)
    canvas=Image.new('RGB',(W,H),(255,0,255))
    for im,sy in zip(tiles,sys_list):
        canvas.paste(im.crop((0,0,W,im.size[1])),(0,round(sy*dpr)))
    canvas.save(out); return canvas
if __name__=='__main__':
    a=json.loads(sys.argv[1]); stitch(a['files'],a['sy'],a['dpr'],a['h'],a['out'],a.get('w'))
