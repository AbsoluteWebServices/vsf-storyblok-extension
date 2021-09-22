import crypto from 'crypto'
import request from 'request'
import { promisify } from 'util'

const rp = promisify(request)

let config

export function setConfig (_config) {
  config = _config

  if (!config.storyblok.index) {
    config.storyblok.index = 'storyblok_stories'
  }

  if (!config.storyblok.entity) {
    config.storyblok.entity = 'story'
  }
}

export function indexName () {
  if (parseInt(config.elasticsearch.apiVersion) < 6) {
    return config.storyblok.index
  } else {
    return `${config.storyblok.index}_${config.storyblok.entity}`
  }
}

export function entityType () {
  if (parseInt(config.elasticsearch.apiVersion) < 6) {
    return config.storyblok.entity
  } else {
    return '_doc'
  }
}

export function getHits (result) {
  if (result.body) { // differences between ES5 andd ES7
    return result.body.hits
  } else {
    return result.hits
  }
}

export function getHitsAsStory (hits) {
  if (hits.total === 0) {
    throw new Error('Missing story')
  }
  const story = hits.hits[0]._source
  if (typeof story.content === 'string') {
    story.content = JSON.parse(story.content)
  }
  return story
}

export const transformId = (id) => {
  return {
    index: indexName(),
    type: entityType(),
    id: id
  }
}

export const getCacheTag = (story) => {
  const slugParts = story.full_slug.split('/')
  let cacheTag = ''

  if (slugParts[0] === 'system') {
    cacheTag = 'SB_SYS'
  } else if (slugParts[0] === 'overrides' && slugParts[1].includes('brand-') && slugParts[2] === 'system') {
    cacheTag = story.full_slug.includes('system/general')
      ? `SB${slugParts[1].substring('brand-'.length)}`
      : 'SB_SYS'
  } else {
    cacheTag = `SB${story.id}`
  }

  return cacheTag
}

export const transformStory = ({ id, ...story } = {}) => {
  story.content = JSON.stringify(story.content)
  story.full_slug = story.full_slug.replace(/^\/|\/$/g, '')
  story.cache_tag = getCacheTag(story)
  return {
    ...transformId(id),
    body: story
  }
}

function mapStoryToBulkAction ({ story: { id } }) {
  return {
    index: {
      _id: id,
      _index: indexName(),
      _type: entityType()
    }
  }
}

export function createBulkOperations (stories = []) {
  return stories.reduce((accumulator, story) => {
    accumulator.push(mapStoryToBulkAction({ story }))
    accumulator.push({
      ...story,
      content: JSON.stringify(story.content)
    })
    return accumulator
  }, [])
}

export function createIndex () {
  return {
    index: indexName(),
    body: {
      settings: {
        'index.mapping.total_fields.limit': config.storyblok.fieldLimit || 1000
      }
    }
  }
}

export function deleteIndex () {
  return {
    index: indexName(),
    ignore_unavailable: true
  }
}

export function queryByPath (path) {
  return {
    index: indexName(),
    type: entityType(),
    body: {
      query: {
        constant_score: {
          filter: {
            term: {
              'full_slug.keyword': path
            }
          }
        }
      }
    }
  }
}

export const log = (string) => {
  console.log('📖 : ' + string) // eslint-disable-line no-console
}

export const cacheInvalidate = async (config, story = null) => {
  if (config.invalidate) {
    const url = config.invalidate
    if (story && story.cache_tag) {
      const queryParams = new URLSearchParams(url)
      queryParams.set('tag', story.cache_tag)
    }
    log(`Invalidating cache... (${config.invalidate})`)
    await rp({ uri: url })
    log('Invalidated cache ✅')
  }
}

export const getStory = async (db, path) => {
  try {
    const response = await db.search(queryByPath(path))
    const hits = getHits(response)
    const story = getHitsAsStory(hits)
    return story
  } catch (error) {
    return {
      story: false
    }
  }
}

export const validateEditor = (params) => {
  const { spaceId, timestamp, token } = params

  const validationString = `${spaceId}:${config.storyblok.previewToken}:${timestamp}`
  const validationToken = crypto.createHash('sha1').update(validationString).digest('hex')
  if (token === validationToken && timestamp > Math.floor(Date.now() / 1000) - 3600) {
    return {
      previewToken: config.storyblok.previewToken,
      error: false
    }
  }
  throw new Error('Unauthorized editor')
}
