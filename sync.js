import { storyblokClient } from './storyblok'
import { log, createIndex, deleteIndex, createBulkOperations, transformId, transformStory, cacheInvalidate } from './helpers'

function indexStories ({ db, stories = [] }) {
  const bulkOps = createBulkOperations(stories)
  return db.bulk({
    body: bulkOps
  })
}

async function syncStories ({ db, page = 1, perPage = 100, environment = null }) {
  const { data: { stories }, total } = await storyblokClient.get('cdn/stories', {
    page,
    per_page: perPage,
    resolve_links: 'url'
  })

  const newStories = stories.filter(story => {
    if (!environment) {
      return true
    }
    const environments = story.tag_list.filter(tag => tag.startsWith('publish-')).map(tag => tag.replace('publish-', ''))
    return environments.length === 0 || environments.includes(environment)
  }).map(story => {
    const fullSlug = story.full_slug.replace(/^\/|\/$/g, '')

    return {
      ...story,
      full_slug: fullSlug,
      folder: fullSlug.lastIndexOf('/') !== -1 ? fullSlug.substring(0, fullSlug.lastIndexOf('/')) : null
    }
  })

  const promise = indexStories({ db, stories: newStories })

  const lastPage = Math.ceil((total / perPage))

  if (page < lastPage) {
    page += 1
    return syncStories({ db, page, perPage, environment })
  }

  return promise
}

const fullSync = async (db, config) => {
  log('Syncing published stories!')

  await db.indices.delete(deleteIndex())
  await db.indices.create(createIndex())
  await syncStories({ db, perPage: config.storyblok.perPage, environment: config.storyblok.environment })
}

const handleHook = async (db, config, params) => {
  const cv = Date.now() // bust cache
  const { story_id: id, action } = params

  switch (action) {
    case 'published':
      const { data: { story } } = await storyblokClient.get(`cdn/stories/${id}`, {
        cv,
        resolve_links: 'url'
      })
      const environment = config.storyblok.environment

      if (environment) {
        const environments = story.tag_list.filter(tag => tag.startsWith('publish-')).map(tag => tag.replace('publish-', ''))
        if (environments.length !== 0 && !environments.includes(environment)) {
          const searchStory = transformId(id)
          const response = await db.exists(searchStory)

          if (response.statusCode === 200) {
            await db.delete(searchStory)
            log(`Unpublished ${story.full_slug}`)
            break
          } else {
            log(`Skipped ${story.full_slug}`)
            return
          }
        }
      }

      const publishedStory = transformStory(story)

      await db.index(publishedStory)
      log(`Published ${story.full_slug}`)
      break

    case 'unpublished':
      const unpublishedStory = transformId(id)
      await db.delete(unpublishedStory)
      log(`Unpublished ${id}`)
      break

    case 'branch_deployed':
      await fullSync(db, config)
      break
    default:
      break
  }
  await cacheInvalidate(config.storyblok)
}

const seedDatabase = async (db, config) => {
  try {
    await db.ping()
    await fullSync(db, config)
    log('Stories synced!')
  } catch (error) {
    log('Stories not synced!')
  }
}

export { syncStories, fullSync, handleHook, seedDatabase }
