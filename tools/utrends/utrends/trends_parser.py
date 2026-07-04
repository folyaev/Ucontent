import feedparser
import logging
import requests
import xml.etree.ElementTree as ET


def parse_traffic_value(value: str) -> int:
    raw = (value or "").strip().lower().replace(",", "").replace(" ", "")
    raw = raw.rstrip("+")
    multiplier = 1
    if raw.endswith("k"):
        multiplier = 1_000
        raw = raw[:-1]
    elif raw.endswith("m"):
        multiplier = 1_000_000
        raw = raw[:-1]
    try:
        return int(float(raw) * multiplier)
    except ValueError:
        return 0


def fetch_google_trends(geo="RU"):
    url = f"https://trends.google.com/trending/rss?geo={geo}"
    # Instead of using feedparser which sometimes trims custom namespace fields,
    # let's use both or simply feedparser if it extracts correctly. 
    # Actually feedparser extracts ht namespaces fine.
    
    feed = feedparser.parse(url)
    results = []
    
    for entry in feed.entries:
        # Extract fields, feedparser converts 'ht:approx_traffic' to 'ht_approx_traffic'
        title = entry.get('title', '')
        link = entry.get('link', '')
        pub_date = entry.get('published', '')
        traffic = entry.get('ht_approx_traffic', '')
        picture = entry.get('ht_picture', '')
        
        # feedparser might not parse nested <ht:news_item> perfectly if there are multiple.
        # Let's fallback to manual xml parsing for news links if needed, but feedparser provides them in `ht_news_item` usually as dict or string?
        # Let's inspect raw xml via requests just to be safe.
        
        results.append({
            'title': title,
            'link': link,
            'traffic': traffic,
            'picture': picture,
            'pub_date': pub_date,
            'id': entry.get('id', title), # fallback to title
            # we'll extract news items separately
        })
        
    # Since feedparser can be tricky with lists of custom tags (multiple <ht:news_item>),
    # let's parse raw XML for reliable extraction of news:
    try:
        response = requests.get(url)
        root = ET.fromstring(response.content)
        
        # XML paths in RSS: channel -> item
        items = root.findall('./channel/item')
        
        # We replace results with a more thorough extraction
        parsed_results = []
        for item in items:
            title_node = item.find('title')
            title = title_node.text if title_node is not None else ""
            
            link_node = item.find('link')
            link = link_node.text if link_node is not None else ""
            
            # namespaces: xmlns:ht="https://trends.google.com/trending/rss"
            traffic_node = item.find('{https://trends.google.com/trending/rss}approx_traffic')
            traffic = traffic_node.text if traffic_node is not None else ""
            
            picture_node = item.find('{https://trends.google.com/trending/rss}picture')
            picture = picture_node.text if picture_node is not None else ""
            
            id_node = item.find('title') # We can use title as ID for simplicity
            item_id = id_node.text if id_node is not None else ""
            
            news_items_nodes = item.findall('{https://trends.google.com/trending/rss}news_item')
            news_list = []
            for n_node in news_items_nodes:
                n_title = n_node.find('{https://trends.google.com/trending/rss}news_item_title')
                n_link = n_node.find('{https://trends.google.com/trending/rss}news_item_url')
                if n_title is not None and n_link is not None:
                    news_list.append({
                        'title': n_title.text,
                        'url': n_link.text
                    })
                    
            if title:
                parsed_results.append({
                    'id': title, # Primary key to avoid duplicates
                    'title': title,
                    'link': link,
                    'traffic': traffic,
                    'picture': picture,
                    'news': news_list
                })
        return parsed_results
    except Exception as e:
        logging.error(f"Error fetching Google Trends via XML: {e}")
        return results

if __name__ == '__main__':
    trends = fetch_google_trends()
    for t in trends[:2]:
        print(t)
