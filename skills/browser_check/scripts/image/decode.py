import sys,base64,re,os
# @@IMG name base64 줄을 파일로 저장
src=sys.argv[1]; outdir=sys.argv[2] if len(sys.argv)>2 else 'img'
os.makedirs(outdir,exist_ok=True)
for line in open(src,encoding='utf-8',errors='replace'):
    m=re.match(r'^@@(IMG|B64) (\S+) (\S+)',line)
    if m:
        data=base64.b64decode(m.group(3))
        p=os.path.join(outdir,m.group(2)); open(p,'wb').write(data)
        info=''
        try:
            from PIL import Image
            im=Image.open(p); info=f'{im.format} {im.size} {im.mode}'
        except Exception as ex: info='nonimage '+str(len(data))
        print(p,len(data),info)
