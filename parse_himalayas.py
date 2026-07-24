import urllib.request
from bs4 import BeautifulSoup
import json

req = urllib.request.Request(
    'https://himalayas.app/companies/nextgen-healthcare/jobs/sr-specialist-i-rcm-quality-assurance', 
    headers={'User-Agent': 'Mozilla/5.0'}
)
html = urllib.request.urlopen(req).read()
soup = BeautifulSoup(html, 'html.parser')
script = soup.find('script', id='__NEXT_DATA__')
if script:
    data = json.loads(script.string)
    print(json.dumps(data, indent=2)[:2000])
else:
    print("No __NEXT_DATA__ found")
