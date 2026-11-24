//! Windows in shared memory, for an engine that composites on the CPU.
//!
//! A card with no 3D gives the engine no GL, so it composites in software and
//! reads only memory (see `domicile_launch::software_compositing`). An shm
//! client's frame is copied into a memfd of the window's, which the engine
//! imports once per memfd (`domicile_surface_import_shm`) and reads without a
//! copy. The client's buffer is free once copied, as on the GPU path, and
//! [`crate::uploads`] keeps a memfd out until viz releases it.
//!
//! The whole frame is copied, not only the damage, since each memfd misses the
//! frames shown from the others. A 1080p frame is 8 MB, about a millisecond.

use std::os::fd::{AsFd as _, AsRawFd as _};

use thiserror::Error;

use crate::casting::memory::Mapping;
use crate::engine::ShmBuffer;
use crate::uploads::Shape;

/// The fourccs the engine shows from memory: the 8-bit ones. Viz's software
/// path draws no 10-bit or half-float image.
const MEMORY_FOURCCS: [u32; 4] = [
    0x3432_5241, // DRM_FORMAT_ARGB8888
    0x3432_5258, // DRM_FORMAT_XRGB8888
    0x3432_4241, // DRM_FORMAT_ABGR8888
    0x3432_4258, // DRM_FORMAT_XBGR8888
];

/// Every format in [`MEMORY_FOURCCS`] is four bytes a pixel.
const BYTES_PER_PIXEL: usize = 4;

/// Why a frame could not be put in memory.
#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("the engine cannot show fourcc {0:#010x} in shared memory")]
    Format(u32),
    #[error("no shared memory for the frame: {0}")]
    Memory(#[from] std::io::Error),
    #[error("the client's pool is shorter than the buffer it describes")]
    Short,
}

/// One memfd holding a window's frame.
#[derive(Debug)]
pub struct MemoryFrame {
    mapping: Mapping,
    shape: Shape,
    /// Bytes a row, with no padding.
    stride: usize,
}

impl MemoryFrame {
    /// A black frame of `shape`.
    pub fn allocate(shape: Shape) -> Result<Self, MemoryError> {
        if !MEMORY_FOURCCS.contains(&shape.fourcc) {
            return Err(MemoryError::Format(shape.fourcc));
        }
        let stride = shape.width as usize * BYTES_PER_PIXEL;
        let mapping = Mapping::new(c"domicile-window", stride * shape.height as usize)?;
        Ok(Self {
            mapping,
            shape,
            stride,
        })
    }

    /// Copies a client's frame in from its pool: `height` rows of `stride`
    /// bytes, from `offset`.
    ///
    /// The caller must hold this frame out of [`crate::uploads::Uploads`], so
    /// viz is not reading it.
    pub fn copy_from(
        &mut self,
        pool: &[u8],
        offset: usize,
        stride: usize,
    ) -> Result<(), MemoryError> {
        // SAFETY: `&mut self`, and the caller holds the frame out, so nothing
        // else reads or writes the mapping.
        let frame = unsafe { self.mapping.bytes() };
        copy_rows(frame, self.stride, pool, offset, stride)
    }

    /// The frame for the engine. Borrows the memfd.
    pub fn describe(&self) -> ShmBuffer {
        ShmBuffer {
            fd: self.mapping.as_fd().as_raw_fd(),
            width: self.shape.width,
            height: self.shape.height,
            stride: self.stride as u32,
            fourcc: self.shape.fourcc,
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.shape.width, self.shape.height)
    }
}

/// Copies every row of `frame` (`row` bytes each) from `pool`, whose rows
/// start at `offset` and are `stride` apart.
fn copy_rows(
    frame: &mut [u8],
    row: usize,
    pool: &[u8],
    offset: usize,
    stride: usize,
) -> Result<(), MemoryError> {
    if row == 0 {
        return Ok(());
    }
    let rows = frame.len() / row;
    let end = rows
        .checked_sub(1)
        .and_then(|last| last.checked_mul(stride))
        .and_then(|last| last.checked_add(offset))
        .and_then(|last| last.checked_add(row));
    if stride < row || end.is_none_or(|end| end > pool.len()) {
        return Err(MemoryError::Short);
    }
    for (index, to) in frame.chunks_exact_mut(row).enumerate() {
        let from = offset + index * stride;
        to.copy_from_slice(&pool[from..from + row]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;
    use std::os::fd::BorrowedFd;

    use super::{copy_rows, MemoryError, MemoryFrame};
    use crate::uploads::Shape;

    const XRGB8888: u32 = 0x3432_5258;

    #[test]
    fn rows_are_copied_past_the_clients_padding() {
        // Two rows of two bytes, from a pool with a byte of padding a row.
        let pool = [9, 1, 2, 9, 3, 4, 9];
        let mut frame = [0; 4];

        copy_rows(&mut frame, 2, &pool, 1, 3).expect("the pool is long enough");

        assert_eq!(frame, [1, 2, 3, 4]);
    }

    #[test]
    fn a_pool_shorter_than_its_buffer_is_refused() {
        let pool = [1, 2, 3];
        let mut frame = [0; 4];

        assert!(matches!(
            copy_rows(&mut frame, 2, &pool, 0, 2),
            Err(MemoryError::Short)
        ));
    }

    #[test]
    fn a_stride_shorter_than_a_row_is_refused() {
        let pool = [0; 16];
        let mut frame = [0; 4];

        assert!(matches!(
            copy_rows(&mut frame, 2, &pool, 0, 1),
            Err(MemoryError::Short)
        ));
    }

    #[test]
    fn the_engine_reads_the_frame_from_the_memfd() {
        let shape = Shape {
            width: 2,
            height: 1,
            fourcc: XRGB8888,
        };
        let mut frame = MemoryFrame::allocate(shape).expect("a memfd");
        frame
            .copy_from(&[1, 2, 3, 4, 5, 6, 7, 8], 0, 8)
            .expect("the pool is long enough");

        let described = frame.describe();
        assert_eq!(
            (described.width, described.height, described.stride),
            (2, 1, 8)
        );
        // SAFETY: the frame keeps the fd open for this test.
        let fd = unsafe { BorrowedFd::borrow_raw(described.fd) };
        let mut read = Vec::new();
        std::fs::File::from(fd.try_clone_to_owned().expect("dup"))
            .read_to_end(&mut read)
            .expect("reads");
        assert_eq!(read, [1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn a_format_the_engine_cannot_show_is_refused() {
        let rgb565 = 0x3631_4752;
        let shape = Shape {
            width: 2,
            height: 1,
            fourcc: rgb565,
        };

        assert!(matches!(
            MemoryFrame::allocate(shape),
            Err(MemoryError::Format(fourcc)) if fourcc == rgb565
        ));
    }

    #[test]
    fn a_10_bit_frame_is_refused() {
        let xbgr2101010 = 0x3033_4258;
        let shape = Shape {
            width: 2,
            height: 1,
            fourcc: xbgr2101010,
        };

        assert!(matches!(
            MemoryFrame::allocate(shape),
            Err(MemoryError::Format(fourcc)) if fourcc == xbgr2101010
        ));
    }
}
