import fetch from 'node-fetch';

// Reddit API endpoint - using the official API
const REDDIT_API_BASE = 'https://www.reddit.com/r';

// Cache for rate limiting
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

function getCachedKey(subreddit, count) {
    return `${subreddit}_${count}`;
}

function getFromCache(key) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.data;
    }
    cache.delete(key);
    return null;
}

function setCache(key, data) {
    cache.set(key, {
        data,
        timestamp: Date.now()
    });
}

async function fetchMemes(subreddit = 'memes', count = 1) {
    try {
        // Validate count
        if (count < 1 || count > 100) {
            throw new Error('Count must be between 1 and 100');
        }

        // Check cache first
        const cacheKey = getCachedKey(subreddit, count);
        const cached = getFromCache(cacheKey);
        if (cached) {
            return cached;
        }

        // Try Reddit first
        try {
            return await fetchFromReddit(subreddit, count, cacheKey);
        } catch (redditError) {
            console.warn('Reddit fetch failed, trying fallback:', redditError.message);
            return await fetchFallbackMemes(subreddit, count, cacheKey);
        }

    } catch (error) {
        console.error('Error fetching memes:', error);
        throw error;
    }
}

async function fetchFromReddit(subreddit, count, cacheKey) {
    // Fetch from Reddit with app-like User-Agent
    const response = await fetch(`${REDDIT_API_BASE}/${subreddit}/hot.json?limit=${Math.min(count * 2, 100)}&raw_json=1`, {
        headers: {
            'User-Agent': 'web:meme-fetch-api:1.0.0 (by /u/memefetchbot)',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        console.error('Reddit API response:', errorText);
        
        // If blocked, return a helpful error message
        if (response.status === 403) {
            throw new Error('Reddit is temporarily blocking requests. This is a known issue with Reddit\'s API restrictions. Please try again later or consider using alternative meme sources.');
        }
        
        throw new Error(`Reddit API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.data || !data.data.children) {
        throw new Error('Invalid Reddit response');
    }

    // Filter and process memes
    const memes = data.data.children
        .filter(post => {
            const postData = post.data;
            // Filter out non-image posts, stickied posts, and over_18 content
            return postData.url && 
                   (postData.url.includes('i.redd.it') || 
                    postData.url.includes('v.redd.it') || 
                    postData.url.includes('preview.redd.it')) &&
                   !postData.stickied &&
                   !postData.over_18 &&
                   postData.title;
        })
        .slice(0, count)
        .map(post => {
            const postData = post.data;
            return {
                postLink: `https://redd.it/${postData.id}`,
                subreddit: postData.subreddit,
                title: postData.title,
                url: postData.url,
                nsfw: postData.over_18 || false,
                spoiler: postData.spoiler || false,
                author: postData.author,
                ups: postData.ups || 0
            };
        });

    const result = {
        count: memes.length,
        memes: memes
    };

    // Cache the result
    setCache(cacheKey, result);

    return result;
}

async function fetchFallbackMemes(subreddit, count, cacheKey) {
    // Fallback to a public meme API
    const response = await fetch(`https://meme-api.com/gimme/${subreddit}/${count}`);
    
    if (!response.ok) {
        throw new Error('Both Reddit and fallback meme APIs are unavailable');
    }
    
    const data = await response.json();
    
    const memes = data.memes ? data.memes.map(meme => ({
        postLink: meme.postLink,
        subreddit: meme.subreddit,
        title: meme.title,
        url: meme.url,
        nsfw: meme.nsfw || false,
        spoiler: meme.spoiler || false,
        author: meme.author || 'unknown',
        ups: meme.ups || 0
    })) : [{
        postLink: '#',
        subreddit: subreddit,
        title: 'Meme temporarily unavailable',
        url: 'https://i.imgflip.com/3i7p.jpg',
        nsfw: false,
        spoiler: false,
        author: 'fallback',
        ups: 0
    }];

    const result = {
        count: memes.length,
        memes: memes.slice(0, count)
    };

    // Cache the result
    setCache(cacheKey, result);

    return result;
}

export default async function handler(req, res) {
    try {
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        // Handle preflight requests
        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }

        if (req.method !== 'GET') {
            return res.status(405).json({ error: 'Method not allowed' });
        }

        const { query } = req;
        const pathParts = query.path || [];

        let subreddit = 'memes';
        let count = 1;

        // Parse URL path: /give, /give/count, /give/subreddit, /give/subreddit/count
        if (pathParts.length === 0) {
            // /give - default case
            subreddit = 'memes';
            count = 1;
        } else if (pathParts.length === 1) {
            // /give/count or /give/subreddit
            const param = pathParts[0];
            if (isNaN(param)) {
                // It's a subreddit
                subreddit = param;
                count = 1;
            } else {
                // It's a count
                subreddit = 'memes';
                count = parseInt(param);
            }
        } else if (pathParts.length === 2) {
            // /give/subreddit/count
            subreddit = pathParts[0];
            count = parseInt(pathParts[1]);
        }

        // Validate inputs
        if (count < 1 || count > 100) {
            return res.status(400).json({ 
                error: 'Count must be between 1 and 100' 
            });
        }

        // Validate subreddit name
        if (!/^[a-zA-Z0-9_]+$/.test(subreddit)) {
            return res.status(400).json({ 
                error: 'Invalid subreddit name' 
            });
        }

        const result = await fetchMemes(subreddit, count);

        if (result.memes.length === 0) {
            return res.status(404).json({ 
                error: 'No memes found for this subreddit',
                count: 0,
                memes: []
            });
        }

        return res.status(200).json(result);

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
}
